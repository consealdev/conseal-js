// SPDX-License-Identifier: AGPL-3.0-or-later OR Commercial
// Copyright (c) 2026 Codesense

/**
 * Conseal — browser-side zero-knowledge cryptography library.
 *
 * Import everything from '@consealdev/conseal':
 *
 *   import { seal, unseal, wrapKey, init, sealMessage, loadCryptoKey, ... } from '@consealdev/conseal'
 *
 * See docs/usage/ for per-function examples.
 */

// AES-256-GCM symmetric encryption
export { seal, unseal, generateAesKey, importAesKey } from './aes.js';

// PBKDF2 passphrase-based key wrapping
export { wrapKey, unwrapKey, rekey, rekeySecretKey } from './pbkdf2.js';

// Secret Key — 128-bit second factor for AEK wrapping
export { generateSecretKey, combinePassphraseAndSecretKey } from './secret-key.js';

// ECDH P-256 message encryption
export { sealMessage, unsealMessage, generateECDHKeyPair } from './ecdh.js';

// ECDSA P-256 signing
export { generateECDSAKeyPair, sign, verify } from './ecdsa.js';

// JWK public key serialisation
export { exportPublicKeyAsJwk, importPublicKeyFromJwk } from './jwk.js';

// New device initialisation
export { init, AEK_KEY_ID } from './init.js';

// BIP-39 mnemonic recovery
export { generateMnemonic, recoverWithMnemonic } from './mnemonic.js';

// Passcode-protected envelope encryption
export { sealEnvelope, unsealEnvelope, encodeEnvelope, decodeEnvelope } from './envelope.js';
export type { SealedEnvelope } from './envelope.js';

// Base64 encoding / decoding
export { toBase64, fromBase64, toBase64Url, fromBase64Url } from './base64.js';

// SHA-256 digest
export { digest } from './digest.js';

// IndexedDB key storage
export { saveCryptoKey, loadCryptoKey, deleteCryptoKey } from './storage.js';

// Multi-device private communication (Circle)
export {
    initCircle,
    createJoinRequest,
    authorizeJoin,
    finalizeJoin,
    deriveVerificationCode,
} from './circle.js';
export type { WrappedAEK, JoinRequest, SealedAEK } from './circle.js';

// Shared encrypted spaces across users (Channel)
export {
    createChannel,
    unwrapChannelAEK,
    createChannelJoinRequest,
    deriveChannelVerificationCode,
    authorizeChannelJoin,
    finalizeChannelJoin,
} from './channel.js';
export type { ChannelJoinRequest } from './channel.js';
