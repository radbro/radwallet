import { useState } from 'preact/hooks';
import { isAddress } from 'viem';
import { addressBook, addressBookEntry, saveAddressContact, say, type AddressBookEntry } from './state.js';
import { removeContact } from './addressbook.js';
import { IconBtn } from './bits.js';

/** A name supplements the destination; it never replaces its address. */
export function LabeledAddress({ address }: { address: string }) {
  const entry = addressBookEntry(address);
  return <span class="labeled-address">
    {entry && <span class="address-label">{entry.label}{entry.owned && <small> · your wallet</small>}</span>}
    <span class="address-value">{address}</span>
  </span>;
}

function ContactForm({ address = '', label = '', fixedAddress = false, onDone }: {
  address?: string; label?: string; fixedAddress?: boolean; onDone: () => void;
}) {
  const [destination, setDestination] = useState(address);
  const [name, setName] = useState(label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hit = addressBookEntry(destination);
  const valid = isAddress(destination) && !!name.trim() && name.trim().length <= 80 && !hit?.owned;
  return <form class="contact-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      await saveAddressContact(destination, name);
      say('address saved');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }}>
    {fixedAddress ? <LabeledAddress address={destination} /> : <label>
      Address
      <input class="field" aria-label="contact address" placeholder="0x…" value={destination} disabled={busy}
        onInput={(event) => { setDestination(event.currentTarget.value.trim()); setError(''); }} />
    </label>}
    {!fixedAddress && destination && !isAddress(destination) && <div class="note">enter a valid address</div>}
    {hit?.owned && <div class="note">this is your wallet: {hit.label}. Rename it in the wallets list.</div>}
    {hit && !hit.owned && !fixedAddress && <div class="note">already saved as {hit.label}; saving updates its label.</div>}
    <label>
      Label
      <input class="field" aria-label="address label" placeholder="e.g. savings" maxLength={80}
        value={name} disabled={busy} onInput={(event) => { setName(event.currentTarget.value); setError(''); }} />
    </label>
    {error && <div class="note contact-error" role="alert">{error}</div>}
    <div class="btnrow">
      <button type="button" class="btn ghost" disabled={busy} onClick={onDone}>CANCEL</button>
      <button type="submit" class="btn" disabled={!valid || busy}>{busy ? 'SAVING…' : 'SAVE ADDRESS'}</button>
    </div>
  </form>;
}

export function QuickAddAddress({ address, disabled = false }: { address: string; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  if (!isAddress(address) || addressBookEntry(address)) return null;
  return editing
    ? <ContactForm key={address.toLowerCase()} address={address} fixedAddress onDone={() => setEditing(false)} />
    : <button type="button" class="act contact-action" disabled={disabled} onClick={() => setEditing(true)}>+ SAVE ADDRESS</button>;
}

function ContactRow({ entry }: { entry: AddressBookEntry }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div class="contact-row">
    <div class="contact-line">
      <LabeledAddress address={entry.address} />
      {!entry.owned && <IconBtn glyph="…" tip="contact actions" label={`actions for ${entry.label}`}
        expanded={menu} onClick={() => { setMenu(!menu); setEditing(false); setRemoving(false); }} />}
    </div>
    {menu && !editing && !removing && <div class="acts">
      <button class="act" onClick={() => setEditing(true)}>edit label</button>
      <button class="act danger" onClick={() => setRemoving(true)}>remove</button>
    </div>}
    {editing && <ContactForm address={entry.address} label={entry.label} fixedAddress
      onDone={() => { setEditing(false); setMenu(false); }} />}
    {removing && <div class="armed">
      <div class="what">remove {entry.label} from your address book?</div>
      {error && <div class="note contact-error" role="alert">{error}</div>}
      <div class="btnrow">
        <button class="btn ghost" disabled={busy} onClick={() => setRemoving(false)}>KEEP IT</button>
        <button class="btn danger" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await removeContact(entry.address); say('address removed'); }
          catch (err) { setError(err instanceof Error ? err.message : String(err)); }
          finally { setBusy(false); }
        }}>REMOVE IT</button>
      </div>
    </div>}
  </div>;
}

/** Shared searchable list for Settings and choosing a Send recipient. */
export function AddressBookList({ onSelect }: { onSelect?: (address: string) => void }) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const all = [...addressBook.value.values()];
  const filtered = all.filter((entry) => `${entry.label} ${entry.address}`.toLowerCase().includes(query));
  return <div class="address-book-list">
    <input class="field" aria-label="search address book" placeholder="search labels or addresses" value={search}
      onInput={(event) => setSearch(event.currentTarget.value)} />
    {filtered.length === 0 && <div class="note">{query ? 'no matching addresses' : 'no saved addresses yet'}</div>}
    {[true, false].map((owned) => {
      const entries = filtered.filter((entry) => entry.owned === owned);
      if (!entries.length) return null;
      return <div key={String(owned)}>
        <div class="testhead">{owned ? 'YOUR WALLETS' : 'SAVED ADDRESSES'}</div>
        {entries.map((entry) => onSelect
          ? <button type="button" class="contact-pick" key={entry.address} onClick={() => onSelect(entry.address)}>
            <LabeledAddress address={entry.address} />
          </button>
          : <ContactRow key={entry.address} entry={entry} />)}
      </div>;
    })}
  </div>;
}

export function AddressBookSettings() {
  const [adding, setAdding] = useState(false);
  return <>
    <div class="note">Saved on this device. Your wallets are included automatically and use their wallet names.</div>
    {adding ? <ContactForm onDone={() => setAdding(false)} />
      : <button class="btn ghost block" onClick={() => setAdding(true)}>+ ADD ADDRESS</button>}
    <AddressBookList />
  </>;
}
