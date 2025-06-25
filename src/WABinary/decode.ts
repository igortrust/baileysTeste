import { promisify } from 'util'
import { inflate } from 'zlib'
import * as constants from './constants'
import { jidEncode } from './jid-utils'
import type { BinaryNode } from './types'

const inflatePromise = promisify(inflate)

export const decompressingIfRequired = async (buffer: Buffer) => {
	if (2 & buffer.readUInt8()) {
		buffer = await inflatePromise(buffer.slice(1))
	} else {
		// nodes with no compression have a 0x00 prefix, we remove that
		buffer = buffer.slice(1)
	}

	return buffer
}

class BinaryDecoder {
	private data: Buffer
	private index: number

	constructor(data: Buffer) {
		this.data = data
		this.index = 0
	}

	private checkEOS(length: number): void {
		if (this.index + length > this.data.length) {
			throw new Error('end of stream')
		}
	}

	private readByte(): number {
		this.checkEOS(1)
		const value = this.data[this.index]
		this.index++
		return value
	}

	private readIntN(n: number, littleEndian = false): number {
		this.checkEOS(n)
		let ret = 0

		for (let i = 0; i < n; i++) {
			const curShift = littleEndian ? i : n - 1 - i
			ret |= this.data[this.index + i] << (curShift * 8)
		}

		this.index += n
		return ret
	}

	private readInt8(littleEndian = false): number {
		return this.readIntN(1, littleEndian)
	}

	private readInt16(littleEndian = false): number {
		return this.readIntN(2, littleEndian)
	}

	private readInt20(): number {
		this.checkEOS(3)
		const ret = ((this.data[this.index] & 15) << 16) + (this.data[this.index + 1] << 8) + this.data[this.index + 2]
		this.index += 3
		return ret
	}

	private readInt32(littleEndian = false): number {
		return this.readIntN(4, littleEndian)
	}

	private readBytes(length: number): Buffer {
		this.checkEOS(length)
		const value = this.data.slice(this.index, this.index + length)
		this.index += length
		return value
	}

	private readBytesOrString(length: number, asString = false): Buffer | string {
		const data = this.readBytes(length)
		return asString ? data.toString('utf-8') : data
	}

	private unpackByte(tag: number, value: number): number {
		if (tag === constants.TAGS.NIBBLE_8) {
			return this.unpackNibble(value)
		} else if (tag === constants.TAGS.HEX_8) {
			return this.unpackHex(value)
		} else {
			throw new Error('unknown tag: ' + tag)
		}
	}

	private unpackNibble(value: number): number {
		if (value >= 0 && value <= 9) {
			return '0'.charCodeAt(0) + value
		}

		switch (value) {
			case 10:
				return '-'.charCodeAt(0)
			case 11:
				return '.'.charCodeAt(0)
			case 15:
				return '\0'.charCodeAt(0)
			default:
				throw new Error('invalid nibble: ' + value)
		}
	}

	private unpackHex(value: number): number {
		if (value >= 0 && value < 16) {
			return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10
		}

		throw new Error('invalid hex: ' + value)
	}

	private readPacked8(tag: number): string {
		const startByte = this.readByte()
		let value = ''

		for (let i = 0; i < (startByte & 127); i++) {
			const curByte = this.readByte()
			value += String.fromCharCode(this.unpackByte(tag, (curByte & 0xf0) >> 4))
			value += String.fromCharCode(this.unpackByte(tag, curByte & 0x0f))
		}

		if (startByte >> 7 !== 0) {
			value = value.slice(0, -1)
		}

		return value
	}

	private readListSize(tag: number): number {
		switch (tag) {
			case constants.TAGS.LIST_EMPTY:
				return 0
			case constants.TAGS.LIST_8:
				return this.readInt8()
			case constants.TAGS.LIST_16:
				return this.readInt16()
			default:
				throw new Error('invalid tag for list size: ' + tag)
		}
	}

	private readString(asString = true): string {
		const tag = this.readByte()

		if (tag >= 1 && tag < constants.SINGLE_BYTE_TOKENS.length) {
			return constants.SINGLE_BYTE_TOKENS[tag] || ''
		}

		switch (tag) {
			case constants.TAGS.DICTIONARY_0:
			case constants.TAGS.DICTIONARY_1:
			case constants.TAGS.DICTIONARY_2:
			case constants.TAGS.DICTIONARY_3:
				return this.getTokenDouble(tag - constants.TAGS.DICTIONARY_0, this.readByte())
			case constants.TAGS.LIST_EMPTY:
				return ''
			case constants.TAGS.BINARY_8:
				return this.readBytesOrString(this.readInt8(), asString) as string
			case constants.TAGS.BINARY_20:
				return this.readBytesOrString(this.readInt20(), asString) as string
			case constants.TAGS.BINARY_32:
				return this.readBytesOrString(this.readInt32(), asString) as string
			case constants.TAGS.JID_PAIR:
				return this.readJidPair()
			case constants.TAGS.AD_JID:
				return this.readAdJid()
			case constants.TAGS.HEX_8:
			case constants.TAGS.NIBBLE_8:
				return this.readPacked8(tag)
			default:
				throw new Error('invalid string with tag: ' + tag)
		}
	}

	private readJidPair(): string {
		const i = this.readString()
		const j = this.readString()
		if (j) {
			return (i || '') + '@' + j
		}

		throw new Error('invalid jid pair: ' + i + ', ' + j)
	}

	private readAdJid(): string {
		const rawDomainType = this.readByte()
		const domainType = Number(rawDomainType)
		const device = this.readByte()
		const user = this.readString()
		return jidEncode(user, domainType === 0 || domainType === 128 ? 's.whatsapp.net' : 'lid', device)
	}

	private getTokenDouble(index1: number, index2: number): string {
		const dict = constants.DOUBLE_BYTE_TOKENS[index1]
		if (!dict) {
			throw new Error(`Invalid double token dict (${index1})`)
		}

		const value = dict[index2]
		if (typeof value === 'undefined') {
			throw new Error(`Invalid double token (${index2})`)
		}

		return value
	}

	private readList(tag: number): BinaryNode[] {
		const items: BinaryNode[] = []
		const size = this.readListSize(tag)
		for (let i = 0; i < size; i++) {
			items.push(this.readNode())
		}

		return items
	}

	public readNode(): BinaryNode {
		const listSize = this.readListSize(this.readByte())
		const header = this.readString()
		if (!listSize || !header) {
			throw new Error('invalid node')
		}

		const attrs: BinaryNode['attrs'] = {}
		let data: BinaryNode['content']

		// read the attributes in
		const attributesLength = (listSize - 1) >> 1
		for (let i = 0; i < attributesLength; i++) {
			const key = this.readString()
			const value = this.readString()
			if (key) {
				attrs[key] = value
			}
		}

		if (listSize % 2 === 0) {
			const tag = this.readByte()
			if (tag === constants.TAGS.LIST_EMPTY || tag === constants.TAGS.LIST_8 || tag === constants.TAGS.LIST_16) {
				data = this.readList(tag)
			} else {
				switch (tag) {
					case constants.TAGS.BINARY_8:
						data = this.readBytesOrString(this.readInt8())
						break
					case constants.TAGS.BINARY_20:
						data = this.readBytesOrString(this.readInt20())
						break
					case constants.TAGS.BINARY_32:
						data = this.readBytesOrString(this.readInt32())
						break
					default:
						data = this.readString()
						break
				}
			}
		}

		return {
			tag: header,
			attrs,
			content: data
		}
	}
}

export const decodeDecompressedBinaryNode = (buffer: Buffer): BinaryNode => {
	const decoder = new BinaryDecoder(buffer)
	return decoder.readNode()
}

export const decodeBinaryNode = async (buff: Buffer): Promise<BinaryNode> => {
	const decompBuff = await decompressingIfRequired(buff)
	return decodeDecompressedBinaryNode(decompBuff)
}
