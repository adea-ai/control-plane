export function isPrivateFileSecretsPlatformSupported(
  platform: string,
  noFollowFlag: number | undefined
): boolean {
  return (
    platform !== 'win32' &&
    Number.isSafeInteger(noFollowFlag) &&
    noFollowFlag !== undefined &&
    noFollowFlag > 0
  )
}
