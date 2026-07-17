import * as openpgp from '../lib/openpgp.min.mjs';

export async function generateKeyPair(name, email, passphrase) {
  const userID = { name };
  if (email) userID.email = email;
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [userID],
    passphrase,
    format: 'armored',
  });
  return { privateKey, publicKey };
}

export async function getKeyInfo(armoredKey) {
  const pubKey = await openpgp.readKey({ armoredKey }).catch(async () => {
    const priv = await openpgp.readPrivateKey({ armoredKey });
    return priv.toPublic();
  });
  return {
    fingerprint:      pubKey.getFingerprint().toUpperCase(),
    keyId:            pubKey.getKeyID().toHex().toUpperCase(),
    userIds:          pubKey.getUserIDs(),
    creationTime:     pubKey.getCreationTime().toISOString(),
    armoredPublicKey: pubKey.armor(),
  };
}

export async function encryptVault(vaultData, armoredPublicKeys) {
  const encryptionKeys = await Promise.all(
    armoredPublicKeys.map(k => openpgp.readKey({ armoredKey: k }))
  );
  const message = await openpgp.createMessage({
    text: JSON.stringify(vaultData),
  });
  return openpgp.encrypt({ message, encryptionKeys });
}

export async function extractPublicKey(armoredPrivateKey) {
  const priv = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  return priv.toPublic().armor();
}

export async function decryptVault(encryptedVault, armoredPrivateKey, passphrase) {
  let privateKey;
  try {
    privateKey = await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }),
      passphrase,
    });
  } catch {
    throw new Error('Incorrect passphrase or invalid private key.');
  }
  const message = await openpgp.readMessage({ armoredMessage: encryptedVault });
  try {
    const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey });
    return JSON.parse(data);
  } catch (err) {
    if (err.message?.includes('No decryption key packets found')) {
      throw new Error('This key is not authorized to open this vault. The vault must have been encrypted to your public key by whoever shared it.');
    }
    throw err;
  }
}
