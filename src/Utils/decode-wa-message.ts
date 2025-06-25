import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto'
import { SignalRepository, WAMessageKey } from '../Types'
import {
	areJidsSameUser,
	BinaryNode,
	isJidBroadcast,
	isJidGroup,
	isJidMetaIa,
	isJidNewsletter,
	isJidStatusBroadcast,
	isJidUser,
	isLidUser,
	jidDecode,
	jidNormalizedUser
} from '../WABinary'
import { unpadRandomMax16 } from './generics'
import { ILogger } from './logger'

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'

export const NACK_REASONS = {
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}

type MessageType =
	| 'chat'
	| 'peer_broadcast'
	| 'other_broadcast'
	| 'group'
	| 'direct_peer_status'
	| 'other_status'
	| 'newsletter'

/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string) {
	let msgType: MessageType
	let chatId: string
	let author: string

	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant: string | undefined = stanza.attrs.participant
	const isMe = (jid: string) => areJidsSameUser(jid, meId)
	const isMeLid = (jid: string) => areJidsSameUser(jid, meLid)
	const participantLid: string | undefined = stanza.attrs.participant_lid
	const senderLid: string | undefined = stanza.attrs.sender_lid
	const recipient: string | undefined = stanza.attrs.recipient
	const senderPn: string | undefined = stanza?.attrs?.sender_pn
	const fromMe = (isLidUser(from) ? isMeLid : isMe)(stanza.attrs.participant || stanza.attrs.from)

	const formatAuthorWithDevice = (userId: string, deviceId: number | undefined) => {
		return deviceId ? `${userId}:${deviceId}@lid` : `${userId}@lid`
	}

	const getAuthorFromLid = (lid: string | undefined, deviceId: number | undefined, fallback: string) => {
		if (!lid) return fallback
		const userId = jidDecode(lid)?.user
		return formatAuthorWithDevice(userId!, deviceId)
	}

	if (isJidUser(from) || isLidUser(from)) {
		if (recipient && !isJidMetaIa(recipient)) {
			if (!isMe(from) && !isMeLid(from)) {
				throw new Boom('recipient present, but msg not from me', { data: stanza })
			}

			chatId = recipient
		} else {
			chatId = from || senderLid
		}

		msgType = 'chat'
		const deviceId = jidDecode(from)?.device

		if (fromMe) {
			const userId = jidDecode(jidNormalizedUser(meLid))?.user
			author = formatAuthorWithDevice(userId!, deviceId)
		} else {
			author = getAuthorFromLid(senderLid, deviceId, from)
		}
	} else if (isJidGroup(from)) {
		if (!participant && !participantLid) {
			throw new Boom('No participant in group message')
		}

		msgType = 'group'
		chatId = from || senderLid
		const deviceId = jidDecode(participant)?.device

		if (fromMe) {
			const userId = jidDecode(jidNormalizedUser(meLid))?.user
			author = formatAuthorWithDevice(userId!, deviceId)
		} else {
			author = getAuthorFromLid(participantLid, deviceId, participant)
		}
	} else if (isJidBroadcast(from)) {
		if (!participant && participantLid) {
			throw new Boom('No participant in group message')
		}

		const isParticipantMe = isMe(participant)
		msgType = isJidStatusBroadcast(from)
			? isParticipantMe
				? 'direct_peer_status'
				: 'other_status'
			: isParticipantMe
				? 'peer_broadcast'
				: 'other_broadcast'

		chatId = from || senderLid
		const deviceId = jidDecode(participant)?.device

		if (fromMe) {
			const userId = jidDecode(meLid)?.user
			author = formatAuthorWithDevice(userId!, deviceId)
		} else {
			author = getAuthorFromLid(participantLid, deviceId, participant)
		}
	} else if (isJidNewsletter(from)) {
		msgType = 'newsletter'
		chatId = from
		author = from
	} else {
		throw new Boom('Unknown message type', { data: stanza })
	}

	const pushname = stanza?.attrs?.notify

	const key: WAMessageKey = {
		remoteJid: chatId,
		fromMe,
		id: msgId,
		...(senderLid && { sender_lid: senderLid }),
		...(participant && { participant }),
		...(participantLid && { participant_lid: participantLid }),
		...(senderPn && { sender_pn: senderPn })
	}

	const fullMessage: proto.IWebMessageInfo = {
		key,
		messageTimestamp: +stanza.attrs.t,
		pushName: pushname,
		broadcast: isJidBroadcast(from)
	}

	if (key.fromMe) {
		fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
	}

	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId
	}
}

export const decryptMessageNode = (
	stanza: BinaryNode,
	meId: string,
	meLid: string,
	repository: SignalRepository,
	logger: ILogger
) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				for (const { tag, attrs, content } of stanza.content) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = proto.VerifiedNameCertificate.decode(content)
						const details = proto.VerifiedNameCertificate.Details.decode(cert.details!)
						fullMessage.verifiedBizName = details.verifiedName
					}

					if (tag !== 'enc' && tag !== 'plaintext') {
						continue
					}

					if (!(content instanceof Uint8Array)) {
						continue
					}

					decryptables += 1

					let msgBuffer: Uint8Array

					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
						switch (e2eType) {
							case 'skmsg':
								msgBuffer = await repository.decryptGroupMessage({
									group: sender,
									authorJid: author,
									msg: content
								})
								break
							case 'pkmsg':
							case 'msg':
								const user = isJidUser(sender) ? sender : author
								msgBuffer = await repository.decryptMessage({
									jid: user,
									type: e2eType,
									ciphertext: content
								})
								break
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}

						let msg: proto.IMessage = proto.Message.decode(
							e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer
						)
						msg = msg.deviceSentMessage?.message || msg
						if (msg.senderKeyDistributionMessage) {
							//eslint-disable-next-line max-depth
							try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.senderKeyDistributionMessage
								})
							} catch (err) {
								logger.error({ key: fullMessage.key, err }, 'failed to decrypt message')
							}
						}

						if (fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
					} catch (err) {
						logger.error({ key: fullMessage.key, err }, 'failed to decrypt message')
						fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message]
					}
				}
			}

			// if nothing was found to decrypt
			if (!decryptables) {
				fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}
