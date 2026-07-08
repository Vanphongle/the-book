import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Craps from "./Craps.jsx";
import Blackjack from "./Blackjack.jsx";

// Tiny hash router: #/craps → Bubble Craps game page, anything else → The Book.
// The game is fully self-contained (play-money, localStorage) and never touches
// the Supabase data.
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (hash.startsWith("#/craps")) return <Craps />;
  if (hash.startsWith("#/blackjack")) return <Blackjack />;
  return <App />;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
