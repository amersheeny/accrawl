/**
 * Credential decryption.
 *
 * Delegated to the active platform (see ../platform): a hosted adapter
 * decrypts via Cloud KMS, the local adapter treats the input as already-plaintext
 * (the /crawl path receives decrypted credentials directly in the request body).
 */

import { getPlatform } from '../platform';

/**
 * Decrypt sensitive data.
 *
 * @param ciphertext - Base64-encoded ciphertext (hosted) or plaintext (local)
 * @returns Decrypted plaintext
 */
export async function decryptSecret(ciphertext: string): Promise<string> {
  return getPlatform().cipher.decrypt(ciphertext);
}
