# SloFlix Stremio/Nuvio dodatek (Cloudflare Workers)

Prijavi se v svoj lasten SloFlix račun, in glej neposredno iz aplikacije. Prikaže katalog filmov/serij, Slovenskih filmov in Sinhroniziranih risank.

Addon se pojavi tudi kot vir (poleg Torrentio, ThePirateBay+, AIOStreams ipd.)
pri poljubnem naslovu, ki ga poiščete v Stremio/Nuvio iskalniku — ne le v
lastnem katalogu — enako kot že prej velja za slovenske podnapise: naslov iz
IMDb (Cinemeta) se ujema z SloFlix katalogom po imenu in letu.
To ni scraper piratskih strani — vedno uporablja vaše lastne SloFlix poverilnice.

## Namestitev na Cloudflare

Projekt je Cloudflare Worker. Ime v `wrangler.jsonc` (`"name": "sloflixnuvioaddon"`)
se **mora ujemati** z imenom projekta/Workerja v Cloudflare, sicer build spodleti.

### Možnost A: povezava z GitHub repozitorijem (Workers Builds)
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
2. Ime projekta: `sloflixnuvioaddon` (enako kot `name` v `wrangler.jsonc`).
3. Build command: pustite prazno (ali `npm install`). Deploy command: `npx wrangler deploy`.
4. Po uspešnem buildu je addon na `https://sloflixnuvioaddon.<vaša-poddomena>.workers.dev`.

### Možnost B: iz ukazne vrstice
```bash
npm install
npx wrangler login
npx wrangler deploy
```

Lokalni zagon: `npm run dev` (privzeto http://localhost:8787/configure).

### Nastavitve
- `SLOFLIX_API_URL` (v `wrangler.jsonc` → `vars`): privzeto `https://api.sloflix.com`.
- `PUBLIC_URL` (neobvezno): le če je addon dostopen na drugem naslovu, kot ga vidi Worker
  (npr. lastna domena z drugačnim preusmerjanjem). Sicer se naslov samodejno zazna iz zahteve.

## Prijavna stran / nastavitve (uporabniško ime + geslo)

Addon zahteva vaš SloFlix e-mail in geslo — teh **ne vpisujete v kodo**, ampak
preko strani `/configure`:

1. Odprite `https://sloflixnuvioaddon.<vaša-poddomena>.workers.dev/configure` v brskalniku.
2. Vnesete SloFlix uporabniško ime in geslo.
3. Kliknete **NAMESTI** — Stremio/Nuvio odpre in namesti addon, če ga ne zazna, kopirajte link v program.

## Opombe za Cloudflare
- Predpomnilnik (katalog, povezave) živi v pomnilniku Workerja in se ob hladnem zagonu znova napolni.
- Brezplačni plan dovoli 50 podzahtevkov na zahtevo; nalaganje celotnega kataloga (do 4000 naslovov
  po 100 na stran) je tik pod to mejo. Pri večjem katalogu uporabite plačljivi plan ali zmanjšajte `maxItems`
  v `src/lib/sloflixClient.js`.
- Video in podnapisi se pretakajo prek Workerja (`/play/`, `/subs/`), zato se šteje vsak Range zahtevek
  pri dnevni kvoti zahtevkov brezplačnega plana.
