import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function restatePublicKey(privateKey) {
  const key = createPublicKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('RESTATE_IDENTITY_KEY_TYPE_INVALID')
  const bytes = Buffer.from(key.export({ format: 'jwk' }).x, 'base64url')
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = BigInt(`0x${bytes.toString('hex')}`)
  let encoded = ''
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded
    number /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    encoded = `1${encoded}`
  }
  return `publickeyv1_${encoded}`
}

export async function provisionRestateIdentity(directory) {
  const root = resolve(directory)
  const stat = await lstat(root)
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid() ||
    (await realpath(root)) !== root
  )
    throw new Error('RESTATE_IDENTITY_DIRECTORY_MUST_BE_PRIVATE_AND_OWNED')
  const path = join(root, 'request-identity-private.pem')
  let file
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  if (file) {
    try {
      const { privateKey } = generateKeyPairSync('ed25519')
      await file.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }))
      await file.sync()
      return restatePublicKey(privateKey)
    } finally {
      await file.close()
    }
  }
  const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await existing.stat()
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid()) {
      throw new Error('RESTATE_IDENTITY_FILE_MUST_BE_PRIVATE_AND_OWNED')
    }
    return restatePublicKey(createPrivateKey(await existing.readFile()))
  } finally {
    await existing.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node provision-restate-identity.mjs DIRECTORY')
  console.log(await provisionRestateIdentity(process.argv[2]))
}
