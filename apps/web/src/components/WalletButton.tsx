// src/components/WalletButton.tsx
import React from 'react';
import { connectPhantom, disconnectPhantom, getProvider, shortPk } from '../utils/wallet';
import { PublicKey } from '@solana/web3.js';

type Props = {
  onChange?: (pk: PublicKey | null) => void;
};

export default function WalletButton({ onChange }: Props) {
  const [pk, setPk] = React.useState<PublicKey | null>(null);

  React.useEffect(() => {
    const p = getProvider();
    if (!p) return;
    // если уже был trusted connect
    if (p.publicKey) {
      setPk(p.publicKey);
      onChange?.(p.publicKey);
    }
    p.on?.('connect', (pubkey: PublicKey) => {
      setPk(pubkey);
      onChange?.(pubkey);
    });
    p.on?.('disconnect', () => {
      setPk(null);
      onChange?.(null);
    });
  }, []);

  const onClick = async () => {
    if (pk) {
      await disconnectPhantom();
      setPk(null);
      onChange?.(null);
    } else {
      const k = await connectPhantom();
      if (k) {
        setPk(k);
        onChange?.(k);
      }
    }
  };

  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 10px',
        borderRadius: 6,
        background: pk ? '#2a3' : '#334',
        color: '#fff',
        border: '1px solid #4b5563',
        cursor: 'pointer',
      }}
      title={pk ? pk.toBase58() : 'Connect Phantom'}
    >
      {pk ? `Wallet: ${shortPk(pk)}` : 'Connect Phantom'}
    </button>
  );
}
