"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeBinaryNode = exports.decodeDecompressedBinaryNode = exports.decompressingIfRequired = void 0;
const util_1 = require("util");
const zlib_1 = require("zlib");
const constants = __importStar(require("./constants"));
const jid_utils_1 = require("./jid-utils");
const inflatePromise = (0, util_1.promisify)(zlib_1.inflate);
const decompressingIfRequired = async (buffer) => {
    if (2 & buffer.readUInt8()) {
        buffer = await inflatePromise(buffer.slice(1));
    }
    else {
        // nodes with no compression have a 0x00 prefix, we remove that
        buffer = buffer.slice(1);
    }
    return buffer;
};
exports.decompressingIfRequired = decompressingIfRequired;
class BinaryDecoder {
    constructor(data) {
        this.data = data;
        this.index = 0;
    }
    checkEOS(length) {
        if (this.index + length > this.data.length) {
            throw new Error('end of stream');
        }
    }
    readByte() {
        this.checkEOS(1);
        const value = this.data[this.index];
        this.index++;
        return value;
    }
    readIntN(n, littleEndian = false) {
        this.checkEOS(n);
        let ret = 0;
        for (let i = 0; i < n; i++) {
            const curShift = littleEndian ? i : n - 1 - i;
            ret |= this.data[this.index + i] << (curShift * 8);
        }
        this.index += n;
        return ret;
    }
    readInt8(littleEndian = false) {
        return this.readIntN(1, littleEndian);
    }
    readInt16(littleEndian = false) {
        return this.readIntN(2, littleEndian);
    }
    readInt20() {
        this.checkEOS(3);
        const ret = ((this.data[this.index] & 15) << 16) + (this.data[this.index + 1] << 8) + this.data[this.index + 2];
        this.index += 3;
        return ret;
    }
    readInt32(littleEndian = false) {
        return this.readIntN(4, littleEndian);
    }
    readBytes(length) {
        this.checkEOS(length);
        const value = this.data.slice(this.index, this.index + length);
        this.index += length;
        return value;
    }
    readBytesOrString(length, asString = false) {
        const data = this.readBytes(length);
        return asString ? data.toString('utf-8') : data;
    }
    unpackByte(tag, value) {
        if (tag === constants.TAGS.NIBBLE_8) {
            return this.unpackNibble(value);
        }
        else if (tag === constants.TAGS.HEX_8) {
            return this.unpackHex(value);
        }
        else {
            throw new Error('unknown tag: ' + tag);
        }
    }
    unpackNibble(value) {
        if (value >= 0 && value <= 9) {
            return '0'.charCodeAt(0) + value;
        }
        switch (value) {
            case 10:
                return '-'.charCodeAt(0);
            case 11:
                return '.'.charCodeAt(0);
            case 15:
                return '\0'.charCodeAt(0);
            default:
                throw new Error('invalid nibble: ' + value);
        }
    }
    unpackHex(value) {
        if (value >= 0 && value < 16) {
            return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10;
        }
        throw new Error('invalid hex: ' + value);
    }
    readPacked8(tag) {
        const startByte = this.readByte();
        let value = '';
        for (let i = 0; i < (startByte & 127); i++) {
            const curByte = this.readByte();
            value += String.fromCharCode(this.unpackByte(tag, (curByte & 0xf0) >> 4));
            value += String.fromCharCode(this.unpackByte(tag, curByte & 0x0f));
        }
        if (startByte >> 7 !== 0) {
            value = value.slice(0, -1);
        }
        return value;
    }
    readListSize(tag) {
        switch (tag) {
            case constants.TAGS.LIST_EMPTY:
                return 0;
            case constants.TAGS.LIST_8:
                return this.readInt8();
            case constants.TAGS.LIST_16:
                return this.readInt16();
            default:
                throw new Error('invalid tag for list size: ' + tag);
        }
    }
    readString(asString = true) {
        const tag = this.readByte();
        if (tag >= 1 && tag < constants.SINGLE_BYTE_TOKENS.length) {
            return constants.SINGLE_BYTE_TOKENS[tag] || '';
        }
        switch (tag) {
            case constants.TAGS.DICTIONARY_0:
            case constants.TAGS.DICTIONARY_1:
            case constants.TAGS.DICTIONARY_2:
            case constants.TAGS.DICTIONARY_3:
                return this.getTokenDouble(tag - constants.TAGS.DICTIONARY_0, this.readByte());
            case constants.TAGS.LIST_EMPTY:
                return '';
            case constants.TAGS.BINARY_8:
                return this.readBytesOrString(this.readInt8(), asString);
            case constants.TAGS.BINARY_20:
                return this.readBytesOrString(this.readInt20(), asString);
            case constants.TAGS.BINARY_32:
                return this.readBytesOrString(this.readInt32(), asString);
            case constants.TAGS.JID_PAIR:
                return this.readJidPair();
            case constants.TAGS.AD_JID:
                return this.readAdJid();
            case constants.TAGS.HEX_8:
            case constants.TAGS.NIBBLE_8:
                return this.readPacked8(tag);
            default:
                throw new Error('invalid string with tag: ' + tag);
        }
    }
    readJidPair() {
        const i = this.readString();
        const j = this.readString();
        if (j) {
            return (i || '') + '@' + j;
        }
        throw new Error('invalid jid pair: ' + i + ', ' + j);
    }
    readAdJid() {
        const rawDomainType = this.readByte();
        const domainType = Number(rawDomainType);
        const device = this.readByte();
        const user = this.readString();
        return (0, jid_utils_1.jidEncode)(user, domainType === 0 || domainType === 128 ? 's.whatsapp.net' : 'lid', device);
    }
    getTokenDouble(index1, index2) {
        const dict = constants.DOUBLE_BYTE_TOKENS[index1];
        if (!dict) {
            throw new Error(`Invalid double token dict (${index1})`);
        }
        const value = dict[index2];
        if (typeof value === 'undefined') {
            throw new Error(`Invalid double token (${index2})`);
        }
        return value;
    }
    readList(tag) {
        const items = [];
        const size = this.readListSize(tag);
        for (let i = 0; i < size; i++) {
            items.push(this.readNode());
        }
        return items;
    }
    readNode() {
        const listSize = this.readListSize(this.readByte());
        const header = this.readString();
        if (!listSize || !header) {
            throw new Error('invalid node');
        }
        const attrs = {};
        let data;
        // read the attributes in
        const attributesLength = (listSize - 1) >> 1;
        for (let i = 0; i < attributesLength; i++) {
            const key = this.readString();
            const value = this.readString();
            if (key) {
                attrs[key] = value;
            }
        }
        if (listSize % 2 === 0) {
            const tag = this.readByte();
            if (tag === constants.TAGS.LIST_EMPTY || tag === constants.TAGS.LIST_8 || tag === constants.TAGS.LIST_16) {
                data = this.readList(tag);
            }
            else {
                switch (tag) {
                    case constants.TAGS.BINARY_8:
                        data = this.readBytesOrString(this.readInt8());
                        break;
                    case constants.TAGS.BINARY_20:
                        data = this.readBytesOrString(this.readInt20());
                        break;
                    case constants.TAGS.BINARY_32:
                        data = this.readBytesOrString(this.readInt32());
                        break;
                    default:
                        data = this.readString();
                        break;
                }
            }
        }
        return {
            tag: header,
            attrs,
            content: data
        };
    }
}
const decodeDecompressedBinaryNode = (buffer) => {
    const decoder = new BinaryDecoder(buffer);
    return decoder.readNode();
};
exports.decodeDecompressedBinaryNode = decodeDecompressedBinaryNode;
const decodeBinaryNode = async (buff) => {
    const decompBuff = await (0, exports.decompressingIfRequired)(buff);
    return (0, exports.decodeDecompressedBinaryNode)(decompBuff);
};
exports.decodeBinaryNode = decodeBinaryNode;
