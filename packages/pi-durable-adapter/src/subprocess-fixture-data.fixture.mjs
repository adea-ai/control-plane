export function createSubprocessFixtureProbe() {
  return [
    'quotes: "double" and \'single\'',
    String.raw`backslashes: \ and \\\\`,
    'newlines: first\nsecond\r\nthird',
    'nul: left\u0000right',
    `line separators: left${String.fromCharCode(0x2028)}middle${String.fromCharCode(0x2029)}right`,
    '</script><script>process.stdout.write("CHILD_FIXTURE_INJECTED")</script>',
    'code-like: "; process.stdout.write("CHILD_FIXTURE_INJECTED"); //',
  ].join('|')
}
