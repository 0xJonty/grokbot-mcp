import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./helpers.ts";
import { AppSession, decryptV10, encryptV10 } from "../src/session.ts";
import { redact } from "../src/log.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbmcp-"));
  const key = crypto.randomBytes(32);
  const dpapiBlob = Buffer.concat([Buffer.from("DPAPI"), Buffer.from("fake-wrapped-key")]);
  fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: dpapiBlob.toString("base64") } }));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.sig`;
  const writeAccount = (token: string, active = "k1") =>
    fs.writeFileSync(
      path.join(dir, "sand-secrets.json"),
      JSON.stringify({
        version: 1,
        "cursor-accounts": JSON.stringify({
          active,
          accounts: { k1: { "cursor-access-token": encryptV10(token, key), "cursor-account-profile": encryptV10(JSON.stringify({ email: "a@b.c", name: "N" }), key) } },
        }),
      }),
    );
  writeAccount(jwt("one"));
  fs.writeFileSync(
    path.join(dir, "gateway-descriptor.json"),
    JSON.stringify({ version: 3, entries: { k1: { savedAtMs: 1, encrypted: encryptV10(JSON.stringify({ baseUrl: "https://p.us14.cursorvm.com/", token: "gt", headers: { "X-Anyrun-Port-Token": "pt" } }), key) } } }),
  );
  fs.writeFileSync(path.join(dir, "desktop-status.json"), JSON.stringify({ appVersion: "1.2.3", signedIn: true, pid: 1 }));
  let unprotectCalls = 0;
  const unprotect = async (blob: Buffer) => {
    unprotectCalls++;
    assert.equal(blob.toString(), "fake-wrapped-key");
    return key;
  };
  return { dir, key, jwt, writeAccount, unprotect, calls: () => unprotectCalls };
}

test("v10 round trip", () => {
  const k = crypto.randomBytes(32);
  assert.equal(decryptV10(encryptV10("hello", k), k), "hello");
});

test("constructor does no disk work", () => {
  const s = new AppSession({ dir: "/definitely/not/here" });
  assert.ok(s);
});

test("loads credentials, caches DPAPI key, re-reads on file change", async () => {
  const f = fixture();
  const s = new AppSession({ dir: f.dir, unprotect: f.unprotect });
  const c1 = await s.credentials();
  assert.equal(c1.accountKey, "k1");
  assert.equal(c1.email, "a@b.c");
  assert.ok(c1.expMs! > Date.now());
  await s.credentials();
  assert.equal(f.calls(), 1);
  // App refreshes token: file changes -> re-read, same DPAPI key reused.
  await new Promise((r) => setTimeout(r, 15));
  f.writeAccount(f.jwt("two") + "x");
  const c2 = await s.credentials();
  assert.notEqual(c2.accessToken, c1.accessToken);
  assert.equal(f.calls(), 1);
  // force re-unwraps key.
  await s.credentials({ force: true });
  assert.equal(f.calls(), 2);
});

test("app route decrypted and headers lowercased", async () => {
  const f = fixture();
  const s = new AppSession({ dir: f.dir, unprotect: f.unprotect });
  const r = await s.appRoute();
  assert.equal(r?.gatewayUrl, "https://p.us14.cursorvm.com");
  assert.deepEqual(r?.headers, { "x-anyrun-port-token": "pt" });
  assert.equal(s.appVersion(), "1.2.3");
});

test("signed out (no active account) -> signed_out error", async () => {
  const f = fixture();
  f.writeAccount("x", "missing");
  const s = new AppSession({ dir: f.dir, unprotect: f.unprotect });
  await assert.rejects(s.credentials(), (e: any) => e.code === "signed_out");
});

test("missing app -> signed_out / not_installed", async () => {
  const s = new AppSession({ dir: path.join(os.tmpdir(), "nope-" + Date.now()), unprotect: async () => Buffer.alloc(32) });
  await assert.rejects(s.credentials(), (e: any) => e.code === "signed_out");
  assert.equal(await s.appRoute(), null);
  assert.equal(s.desktopStatus(), null);
});

test("redact strips tokens", () => {
  const s = redact("authorization: Bearer abc.def-ghi token=supersecret eyJabcdefghij.eyJabcdefghij.sig " + "A".repeat(60));
  assert.ok(!/abc\.def|supersecret|eyJabcdefghij|AAAAAAAAAA/.test(s), s);
  assert.equal(redact("bot 00000000-1111-4222-8333-444444444444 ok"), "bot 00000000-1111-4222-8333-444444444444 ok");
});

test("asarPackageVersion reads package.json from an app.asar", async () => {
  const { asarPackageVersion } = await import("../src/session.ts");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const pkg = Buffer.from(JSON.stringify({ name: "x", version: "9.8.7" }));
  const other = Buffer.from("console.log(1)");
  const index = Buffer.from(JSON.stringify({ files: { "main.js": { size: other.length, offset: "0" }, "package.json": { size: pkg.length, offset: String(other.length) } } }));
  const pad = (4 - (index.length % 4)) % 4;
  const headerPickle = Buffer.alloc(8 + index.length + pad);
  headerPickle.writeUInt32LE(4 + index.length + pad, 0);
  headerPickle.writeUInt32LE(index.length, 4);
  index.copy(headerPickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(headerPickle.length, 4);
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), "asar-"));
  const f = pathm.join(dir, "app.asar");
  fsm.writeFileSync(f, Buffer.concat([size, headerPickle, other, pkg]));
  assert.equal(asarPackageVersion(f), "9.8.7");
  assert.equal(asarPackageVersion(pathm.join(dir, "missing.asar")), undefined);
  fsm.rmSync(dir, { recursive: true, force: true });
});
