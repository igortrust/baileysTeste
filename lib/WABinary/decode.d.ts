import type { BinaryNode } from './types';
export declare const decompressingIfRequired: (buffer: Buffer) => Promise<Buffer<ArrayBufferLike>>;
export declare const decodeDecompressedBinaryNode: (buffer: Buffer) => BinaryNode;
export declare const decodeBinaryNode: (buff: Buffer) => Promise<BinaryNode>;
