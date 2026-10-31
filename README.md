# SloFlix Stremio/Nuvio dodatek (Cloudflare Workers)

Prijavi se v svoj lasten SloFlix račun, in glej neposredno iz aplikacije. Prikaže katalog filmov/serij, Slovenskih filmov in Sinhroniziranih risank.

Addon se pojavi tudi kot vir (poleg Torrentio, ThePirateBay+, AIOStreams ipd.)
pri poljubnem naslovu, ki ga poiščete v Stremio/Nuvio iskalniku — ne le v
lastnem katalogu — enako kot že prej velja za slovenske podnapise: naslov iz
IMDb (Cinemeta) se ujema z SloFlix katalogom po imenu in letu.
To ni scraper piratskih strani — vedno uporablja vaše lastne SloFlix poverilnice.


## Prijavna stran / nastavitve (uporabniško ime + geslo)

Addon zahteva vaš SloFlix e-mail in geslo — teh **ne vpisujete v kodo**, ampak
preko strani `/configure`:

1. Odprite `https://sloflixnuvioaddon.gregor-debeljak.workers.dev` v brskalniku.
2. Vnesete SloFlix uporabniško ime in geslo.
3. Kliknete **NAMESTI** — Stremio/Nuvio odpre in namesti addon, če ga ne zazna, kopirajte link v program.

