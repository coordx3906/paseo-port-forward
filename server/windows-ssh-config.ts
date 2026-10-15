/** Turn ssh -G's effective options into a config without inherited forwards. */
export function connectionConfig(output: string, host = "*"): string {
  const lines = output.split(/\r?\n/).filter((line) =>
    line && !/^(host|localforward|remoteforward|dynamicforward|clearallforwardings|controlmaster|controlpath|controlpersist|forkafterauthentication|sessiontype|remotecommand|requesttty|exitonforwardfailure)\s/i.test(line),
  );
  return `Host ${JSON.stringify(host)}\nClearAllForwardings no\n` + lines.map((line) => {
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    const quote = (path: string) => JSON.stringify(path.replaceAll("\\", "/"));
    // ssh -G prints expanded Windows paths without quotes, even for spaced usernames.
    if (/^(userknownhostsfile|globalknownhostsfile)$/.test(key)) {
      return `${key} ${value.split(/\s+(?=[A-Za-z]:[\\/]|\/|~|__PROGRAMDATA__)/).map(quote).join(" ")}`;
    }
    if (/^(identityfile|certificatefile|identityagent|controlpath|revokedhostkeys|xauthlocation|pkcs11provider|securitykeyprovider)$/.test(key)) {
      return `${key} ${quote(value)}`;
    }
    return line;
  }).join("\n") + "\n";
}
