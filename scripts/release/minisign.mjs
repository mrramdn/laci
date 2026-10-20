// Checks an updater signature the way tauri-plugin-updater does before it installs anything: the minisign signature
// of the file and the trusted comment under the public key, and then, as `requireSignedVersion` asks, the version
// the trusted comment names. `tauri signer sign` writes the signature file as base64 of minisign's text.
//   node scripts/release/minisign.mjs <file> <file.sig> <version> [<public key file>]
// Without a key file it uses tauri.conf.json's plugins.updater.pubkey, the key every Laci checks updates with.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseVersion, root } from "./version.mjs";

const fromBase64 = (text, what) => {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new Error(`${what} is not base64`);
  return Buffer.from(trimmed, "base64");
};

/** The key the app ships: tauri.conf.json's plugins.updater.pubkey, base64 of minisign's public key file. */
export function shippedPublicKey(dir = root) {
  return JSON.parse(readFileSync(path.join(dir, "src-tauri/tauri.conf.json"), "utf8")).plugins.updater.pubkey;
}

/** A minisign public key, given as Tauri stores it: base64 of the two-line .pub file. */
export function parsePublicKey(base64) {
  const lines = fromBase64(base64, "The public key").toString("utf8").trim().split("\n");
  if (lines.length !== 2 || !lines[0].startsWith("untrusted comment:")) throw new Error("Not a minisign public key");
  const raw = fromBase64(lines[1], "The public key");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") throw new Error("Not an Ed25519 minisign public key");
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") },
    format: "jwk",
  });
  return { keyId: keyId(raw.subarray(2, 10)), key };
}

// minisign prints key ids as the 8 bytes read little-endian, in hex.
const keyId = (bytes) => Buffer.from(bytes).reverse().toString("hex").toUpperCase();

/** A signature file as `tauri signer sign` writes it: base64 of minisign's four lines. */
export function parseSignature(base64) {
  const lines = fromBase64(base64, "The signature").toString("utf8").replace(/\n$/, "").split("\n");
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("Not a minisign signature");
  }
  const raw = fromBase64(lines[1], "The signature");
  const algorithm = raw.toString("latin1", 0, 2);
  if (raw.length !== 74 || (algorithm !== "Ed" && algorithm !== "ED")) throw new Error("Not an Ed25519 signature");
  const global = fromBase64(lines[3], "The trusted comment's signature");
  if (global.length !== 64) throw new Error("The trusted comment's signature has the wrong length");
  const trustedComment = lines[2].slice("trusted comment: ".length);
  return { prehashed: algorithm === "ED", keyId: keyId(raw.subarray(2, 10)), signature: raw.subarray(10), trustedComment, global };
}

/** The fields of a trusted comment Tauri writes: tab-separated key:value pairs. */
export function commentFields(trustedComment) {
  const fields = {};
  for (const pair of trustedComment.split("\t")) {
    const at = pair.indexOf(":");
    if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return fields;
}

/**
 * Checks `data` against a signature file's text and a public key, and that the signature was made for `version`.
 * Answers the key id and the trusted comment's fields. Throws, saying why, for anything the updater would refuse.
 */
export function verifyUpdate(data, signatureBase64, publicKeyBase64, version) {
  const publicKey = parsePublicKey(publicKeyBase64);
  const signature = parseSignature(signatureBase64);
  if (signature.keyId !== publicKey.keyId) {
    throw new Error(`Signed with key ${signature.keyId}, but the public key is ${publicKey.keyId}`);
  }
  const message = signature.prehashed ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, publicKey.key, signature.signature)) throw new Error("The signature doesn't match the file");
  const signed = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")]);
  if (!verify(null, signed, publicKey.key, signature.global)) throw new Error("The trusted comment's signature is wrong");
  // Only now is the trusted comment worth reading.
  const fields = commentFields(signature.trustedComment);
  if (fields.version === undefined) throw new Error("The signature names no version; requireSignedVersion refuses it");
  const signedVersion = fields.version.replace(/^v/, "");
  if (!parseVersion(signedVersion) || signedVersion !== version.replace(/^v/, "")) {
    throw new Error(`The signature is for version ${fields.version}, not ${version}`);
  }
  return { keyId: publicKey.keyId, fields };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, sig, version, keyFile] = process.argv.slice(2);
  if (!file || !sig || !version) {
    console.error("Usage: node scripts/release/minisign.mjs <file> <file.sig> <version> [<public key file>]");
    process.exit(2);
  }
  try {
    const publicKey = keyFile ? readFileSync(keyFile, "utf8") : shippedPublicKey();
    const { keyId: id, fields } = verifyUpdate(readFileSync(file), readFileSync(sig, "utf8"), publicKey, version);
    console.log(`Good signature of ${path.basename(file)} by key ${id}, for version ${fields.version} (file ${fields.file})`);
  } catch (error) {
    console.error(`${path.basename(file)}: ${error.message}`);
    process.exit(1);
  }
}
