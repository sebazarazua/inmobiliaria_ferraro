// Decorative outline icons (24px grid, 1.75 stroke). Always aria-hidden: the label next to them carries the meaning.
const paths={
  dashboard:<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>,
  contract:<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></>,
  building:<><path d="M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10"/><path d="M3 21h18"/><path d="M9 7h3"/><path d="M9 11h3"/><path d="M9 15h3"/></>,
  home:<><path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/></>,
  user:<><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></>,
  users:<><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/></>,
  shield:<><path d="M12 3 5 6v5.5c0 4.4 2.9 7.7 7 9.5 4.1-1.8 7-5.1 7-9.5V6z"/><path d="m9 12 2 2 4-4"/></>,
  wallet:<><path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4H6a2 2 0 0 0 0 4h13a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6"/><path d="M16.5 14h.01"/></>,
  receipt:<><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h3"/></>,
  clock:<><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></>,
  expense:<><path d="M3 7l6 6 4-4 8 8"/><path d="M21 11v6h-6"/></>,
  service:<><path d="M13 3 4.5 14H11l-1 7 8.5-11H12z"/></>,
  income:<><circle cx="12" cy="12" r="8.5"/><path d="M12 8v8"/><path d="M8 12h8"/></>,
  message:<><path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"/></>,
  alert:<><path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/></>,
  folder:<><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></>,
  import:<><path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M5 20.5h14"/></>,
  settings:<><path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="9" cy="17" r="2"/></>,
  chevron:<><path d="m6.5 9.5 5.5 5.5 5.5-5.5"/></>,
  menu:<><path d="M4 6.5h16"/><path d="M4 12h16"/><path d="M4 17.5h16"/></>,
  close:<><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/></>,
  search:<><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/></>,
  pencil:<><path d="M4.5 19.5h3.8L19 8.8a2.7 2.7 0 0 0-3.8-3.8L4.5 15.7z"/><path d="m13.8 6.4 3.8 3.8"/></>,
  upload:<><path d="M12 15.5v-11"/><path d="m7.5 9 4.5-4.5L16.5 9"/><path d="M5 19.5h14"/></>
};
export function Icon({name,size=16,className=''}){const shape=paths[name];if(!shape)return null;return <svg className={`icon ${className}`.trim()} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{shape}</svg>}
