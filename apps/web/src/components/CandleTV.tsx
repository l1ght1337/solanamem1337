// src/components/CandleTV.tsx
import React from 'react';
import { useStore } from '../store';

export default function CandleTV() {
  const price = useStore(s => s.price);

  return (
    <div style={{
      border:'1px solid #1f2837',
      borderRadius:10,
      height: 320,
      background:'#0b1018',
      display:'flex',
      alignItems:'center',
      justifyContent:'center',
      color:'#7f8ea3'
    }}>
      <div>Chart placeholder — Price: {price ? price.toFixed(9) : '—'}</div>
    </div>
  );
}
