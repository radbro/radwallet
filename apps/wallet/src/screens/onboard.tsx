import { useState } from 'preact/hooks';
import {
  screen, createWallet, importWallet, importKeyAsWallet, unlock, say, DEMO, sayError,
  bioSealed, bioReady, unlockWithBiometrics,
} from '../state.js';
import { LOGO } from '../assets.js';
import { useScreenGuard } from '../bits.js';
import { FooterRing } from '../bits.js';

const MIN_VAULT_PASSWORD_CHARS = 16;
const PASSWORD_HINT = `${MIN_VAULT_PASSWORD_CHARS}+ characters. Use a password manager secret or a long passphrase.`;

export function Welcome() {
  return (
    <div class="content">
      <img class="boot-logo" src={LOGO} alt="radbro head" />
      <h2 class="serif">RADWALLET</h2>
      <div class="center dim" style={{ fontSize: 12 }}>an EVM wallet for rad bros</div>
      <div class="creed">
        <b>No accounts.</b> Your keys never leave this machine.<br />
        <b>No tracking.</b> There is no server to phone home to.<br />
        <b>Zero RADWALLET swap fee.</b> Network and protocol fees still apply.<br />
        <b>Open source.</b> Gatekeeping a wallet in the age of AI is ridiculous.
      </div>
      <hr class="hr-rainbow" />
      <div style={{ padding: '0 20px' }}>
        <button class="btn block" style={{ marginBottom: 10 }} onClick={() => (screen.value = 'create')}>
          MAKE A NEW WALLET
        </button>
        <button class="btn block ghost" onClick={() => (screen.value = 'import')}>
          I ALREADY HAVE ONE
        </button>
      </div>
      <div class="counterline">
        seed generated locally · BIP-39 · never transmitted
        {DEMO && <><br />DEMO MODE: chain data is canned, key generation is real</>}
      </div>
      <FooterRing />
    </div>
  );
}

export function Create() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [seed, setSeed] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  // the twelve words are the wallet. no screenshot, no screen recorder, and no
  // thumbnail of them in the app switcher
  useScreenGuard(seed !== null);

  if (seed) {
    return (
      <div class="content">
        <div class="simhead">[ SEED PHRASE INTENSIFIES ]</div>
        <div class="note center">
          write these 12 words down on paper. anyone with them IS you.
        </div>
        <div class="seedbox">
          {seed.split(' ').map((w, i) => (
            <span key={i}>
              <b>{i + 1}</b> {w}{' '}
            </span>
          ))}
        </div>
        <div class="obey" style={{ fontSize: 14 }}>
          NO SERVER HAS A COPY. THAT IS THE FEATURE.
        </div>
        <label class="row">
          <input type="checkbox" checked={ack} onChange={(e) => setAck((e.target as HTMLInputElement).checked)} />
          <span>I wrote it down. On paper. Like a rad bro.</span>
        </label>
        <button class="btn block" disabled={!ack} onClick={() => (screen.value = 'home')}>
          ENTER THE WEBRING
        </button>
        <FooterRing />
      </div>
    );
  }

  return (
    <div class="content">
      <h2 class="serif">New Wallet</h2>
      <div class="note center">password encrypts the vault on this device (AES-256-GCM, 600k PBKDF2 rounds)</div>
      {/*
        A real <form>, because a password manager cannot see anything else.
        Firefox captures on form submission (and Chrome on the same signal), so
        the fields the wallet had before — loose inputs in a screen that never
        submits and never navigates — were invisible to it. Verified in real
        Firefox: the save-login prompt fires for a moz-extension:// page with a
        form, and never fires without one.
        The browser still ASKS before it stores anything, which is the consent
        gate; our job is only to stop hiding the question.
      */}
      <form class="pwform" onSubmit={async (e) => {
        e.preventDefault();
        if (pw.length >= MIN_VAULT_PASSWORD_CHARS && pw === pw2) setSeed(await createWallet(pw));
      }}>
        <input
          class="field" type="password" name="password" autocomplete="new-password"
          placeholder="password"
          value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        <input
          class="field" type="password" name="password-confirm" autocomplete="new-password"
          placeholder="password again"
          value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
        <button class="btn block" type="submit" disabled={pw.length < MIN_VAULT_PASSWORD_CHARS || pw !== pw2}>
          GENERATE SEED
        </button>
      </form>
      {pw.length > 0 && pw.length < MIN_VAULT_PASSWORD_CHARS && <div class="note center">{PASSWORD_HINT}</div>}
      {pw2.length > 0 && pw !== pw2 && <div class="note center" style={{ color: '#ff2a2a' }}>passwords do not match</div>}
      <div class="center" style={{ marginTop: 10 }}>
        <button class="redlink" onClick={() => (screen.value = 'welcome')}>← back</button>
      </div>
      <FooterRing />
    </div>
  );
}

export function Import() {
  const [pw, setPw] = useState('');
  const [words, setWords] = useState('');
  const [mode, setMode] = useState<'seed' | 'key'>('seed');
  const isSeed = mode === 'seed';
  // typing a seed phrase or a private key INTO the phone puts the same secret
  // on the same screen — a recorder does not care which direction it moved
  useScreenGuard(true);
  const ready = isSeed ? words.trim().split(/\s+/).length >= 12 : words.trim().length >= 64;
  return (
    <div class="content">
      <h2 class="serif">Import</h2>
      <div class="acctring" style={{ marginBottom: 4 }}>
        <button class={`redlink${isSeed ? ' on' : ''}`} onClick={() => setMode('seed')}>seed phrase</button>
        {' | '}
        <button class={`redlink${isSeed ? '' : ' on'}`} onClick={() => setMode('key')}>private key</button>
      </div>
      <div class="note center">
        {isSeed
          ? '12/24-word BIP-39 seed phrase. It never leaves this device.'
          : 'a raw 32-byte private key. one address, no derivation, no stealth address — and nothing else backs it up.'}
      </div>
      <textarea class="field" placeholder={isSeed ? 'seed phrase…' : '0x…'}
        value={words} onInput={(e) => setWords((e.target as HTMLTextAreaElement).value)} />
      <form class="pwform" onSubmit={async (e) => {
        e.preventDefault();
        if (pw.length < MIN_VAULT_PASSWORD_CHARS || !ready) return;
        try {
          if (isSeed) await importWallet(words, pw);
          else await importKeyAsWallet(words, pw);
        } catch (err) { sayError(err); }
      }}>
        <input
          class="field" type="password" name="password" autocomplete="new-password"
          placeholder="new local password"
          value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        <button class="btn block" type="submit" disabled={pw.length < MIN_VAULT_PASSWORD_CHARS || !ready}>
          IMPORT
        </button>
      </form>
      {pw.length > 0 && pw.length < MIN_VAULT_PASSWORD_CHARS && <div class="note center">{PASSWORD_HINT}</div>}
      <div class="center" style={{ marginTop: 10 }}>
        <button class="redlink" onClick={() => (screen.value = 'welcome')}>← back</button>
      </div>
      <FooterRing />
    </div>
  );
}

export function Unlock() {
  const [pw, setPw] = useState('');
  const bio = bioSealed.value && bioReady.value.available;
  return (
    <div class="content">
      <img class="boot-logo" src={LOGO} alt="" />
      <h2 class="serif">Locked</h2>
      <div class="note center">vault is sealed on this device. enter password.</div>
      {/* submitting a form is also what makes Enter work without a keydown
          handler of our own — the browser has always done that part */}
      <form class="pwform" onSubmit={async (e) => {
        e.preventDefault();
        try { await unlock(pw); } catch { say('wrong password, bro'); }
      }}>
        <input
          class="field" type="password" name="password" autocomplete="current-password"
          placeholder="password" value={pw}
          onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        <button class="btn block" type="submit">UNLOCK</button>
      </form>
      {/* the password stays the way in — a phone that will not read your finger
          today (wet hands, a cracked reader) is not a phone that locked you out */}
      {bio && (
        <button
          class="btn block ghost bio"
          onClick={() => { void unlockWithBiometrics().catch(sayError); }}
        >UNLOCK WITH BIOMETRICS</button>
      )}
      <FooterRing />
    </div>
  );
}
