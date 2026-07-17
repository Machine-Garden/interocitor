import { createWebSecretStore } from "/packages/web/dist/index.js";
import {
  exportPrivateKey,
  exportPublicKey,
  importPrivateKey,
  importPublicKey,
  signToken,
  verifyToken,
  generateSigningKeypair,
} from "/packages/core/dist/index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const els = {
  recordInput: document.querySelector("#recordInput"),
  claimsInput: document.querySelector("#claimsInput"),
  provisionStoredKeyBtn: document.querySelector("#provisionStoredKeyBtn"),
  provisionSealKeyBtn: document.querySelector("#provisionSealKeyBtn"),
  sealRecordBtn: document.querySelector("#sealRecordBtn"),
  unsealRecordBtn: document.querySelector("#unsealRecordBtn"),
  provisionSignerBtn: document.querySelector("#provisionSignerBtn"),
  addPhoneBtn: document.querySelector("#addPhoneBtn"),
  signTokenBtn: document.querySelector("#signTokenBtn"),
  verifyTokenBtn: document.querySelector("#verifyTokenBtn"),
  storedOutput: document.querySelector("#storedOutput"),
  sealOutput: document.querySelector("#sealOutput"),
  signOutput: document.querySelector("#signOutput"),
  statusOutput: document.querySelector("#statusOutput"),
};

const storedKeyStore = createWebSecretStore("interocitor-demo:stored-key");

const sealKeyStore = createWebSecretStore("interocitor-demo:record-seal-key", {
  custody: "webauthnPlatform",
  displayName: "Interocitor Key Demo",
});

const signerStore = createWebSecretStore("interocitor-demo:jwt-signer", {
  custody: "webauthnCrossPlatform",
  displayName: "Interocitor Key Demo",
});

let lastSealedRecord = null;
let lastSignedToken = "";

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) output[i] = binary.charCodeAt(i);
  return output;
}

function setStatus(message, error = null) {
  const suffix = error
    ? `\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    : "";
  els.statusOutput.textContent = `${message}${suffix}`;
}

async function provisionStoredKey() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  await storedKeyStore.save(key);
  const restored = await storedKeyStore.load();
  els.storedOutput.textContent = JSON.stringify(
    {
      custody: storedKeyStore.custody,
      storedBytes: restored?.byteLength ?? 0,
      prompt: false,
    },
    null,
    2,
  );
  setStatus("Stored security key saved in localStorage.");
}

async function loadOrCreateSealKey() {
  const stored = await sealKeyStore.load();
  if (stored) {
    return crypto.subtle.importKey("raw", stored, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  await sealKeyStore.save(raw);
  return key;
}

async function loadOrCreateSigningBundle() {
  const stored = await signerStore.load();
  if (stored) {
    const parsed = JSON.parse(textDecoder.decode(stored));
    return {
      privateKey: await importPrivateKey(parsed.privateKeyPkcs8),
      publicKey: await importPublicKey(parsed.publicKeySpki),
      created: false,
      publicKeySpki: parsed.publicKeySpki,
    };
  }

  const { privateKey, publicKey } = await generateSigningKeypair();
  const bundle = {
    privateKeyPkcs8: await exportPrivateKey(privateKey),
    publicKeySpki: await exportPublicKey(publicKey),
  };
  await signerStore.save(textEncoder.encode(JSON.stringify(bundle)));
  return {
    privateKey,
    publicKey,
    created: true,
    publicKeySpki: bundle.publicKeySpki,
  };
}

async function addPhone() {
  let stored = await signerStore.load();
  if (!stored) {
    const bundle = await loadOrCreateSigningBundle();
    els.signOutput.textContent = JSON.stringify(
      {
        created: bundle.created,
        publicKeySpki: bundle.publicKeySpki,
        authenticators: signerStore.listAuthenticators?.(),
      },
      null,
      2,
    );
    setStatus("First phone/cross-platform authenticator enrolled for enforced security.");
    return;
  }
  const ref = await signerStore.enrollAuthenticator(stored, {
    label: "Phone",
    authenticatorAttachment: "cross-platform",
    hints: ["hybrid"],
    transports: ["hybrid"],
  });
  els.signOutput.textContent = JSON.stringify(
    {
      phoneCredential: ref,
      authenticators: signerStore.listAuthenticators?.(),
    },
    null,
    2,
  );
  setStatus("Phone/cross-platform authenticator enrolled for enforced security.");
}

async function provisionSealKey() {
  await loadOrCreateSealKey();
  setStatus("Platform-preferred seal key is ready.");
}

async function sealRecord() {
  const key = await loadOrCreateSealKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const source = els.recordInput.value.trim();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(source),
  );

  lastSealedRecord = {
    alg: "AES-GCM",
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };

  els.sealOutput.textContent = JSON.stringify(lastSealedRecord, null, 2);
  setStatus("Record sealed. The decrypt step will ask for the same platform-backed key again.");
}

async function unsealRecord() {
  if (!lastSealedRecord) {
    els.sealOutput.textContent = "Seal a record first.";
    return;
  }

  const key = await loadOrCreateSealKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(lastSealedRecord.iv) },
    key,
    decodeBase64(lastSealedRecord.ciphertext),
  );

  els.sealOutput.textContent = textDecoder.decode(plaintext);
  setStatus("Record unsealed after biometric confirmation.");
}

async function provisionSigner() {
  const bundle = await loadOrCreateSigningBundle();
  els.signOutput.textContent = JSON.stringify(
    {
      created: bundle.created,
      publicKeySpki: bundle.publicKeySpki,
    },
    null,
    2,
  );
  setStatus("Cross-platform signer is ready.");
}

async function signClaims() {
  const bundle = await loadOrCreateSigningBundle();
  const claims = JSON.parse(els.claimsInput.value.trim());
  lastSignedToken = await signToken(bundle.privateKey, claims, { expiresInSeconds: 300 });
  els.signOutput.textContent = lastSignedToken;
  setStatus(
    "Claims signed. The private key stayed inside the protected blob store until this ceremony loaded it.",
  );
}

async function verifyLastToken() {
  if (!lastSignedToken) {
    els.signOutput.textContent = "Sign a token first.";
    return;
  }

  const bundle = await loadOrCreateSigningBundle();
  const verified = await verifyToken(bundle.publicKey, lastSignedToken);
  els.signOutput.textContent = JSON.stringify(
    {
      token: lastSignedToken,
      verified,
    },
    null,
    2,
  );
  setStatus("Token verified with the exported public key.");
}

els.provisionSealKeyBtn.addEventListener("click", () => {
  provisionSealKey().catch((error) => setStatus("Failed to provision platform seal key.", error));
});
els.provisionStoredKeyBtn.addEventListener("click", () => {
  provisionStoredKey().catch((error) =>
    setStatus("Failed to provision stored security key.", error),
  );
});
els.sealRecordBtn.addEventListener("click", () => {
  sealRecord().catch((error) => setStatus("Failed to seal record.", error));
});
els.unsealRecordBtn.addEventListener("click", () => {
  unsealRecord().catch((error) => setStatus("Failed to unseal record.", error));
});
els.provisionSignerBtn.addEventListener("click", () => {
  provisionSigner().catch((error) =>
    setStatus("Failed to provision cross-platform signer.", error),
  );
});
els.addPhoneBtn.addEventListener("click", () => {
  addPhone().catch((error) => setStatus("Failed to add phone.", error));
});
els.signTokenBtn.addEventListener("click", () => {
  signClaims().catch((error) => setStatus("Failed to sign token.", error));
});
els.verifyTokenBtn.addEventListener("click", () => {
  verifyLastToken().catch((error) => setStatus("Failed to verify token.", error));
});
