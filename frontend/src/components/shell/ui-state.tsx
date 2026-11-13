"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
}

const Ctx = createContext<UiState | null>(null);

export function UiStateProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const value = useMemo(
    () => ({ paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen, mobileNavOpen, setMobileNavOpen }),
    [paletteOpen, shortcutsOpen, mobileNavOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUi must be used inside UiStateProvider");
  return v;
}
