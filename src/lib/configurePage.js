
// Custom /configure page, replacing stremio-addon-sdk's default
// landingTemplate. Two differences from the stock template:
//
// 1. All copy is in Slovenian, and the "this addon has" list is hardcoded
//    (rather than derived from manifest.types) so it can include the two
//    SloFlix-specific catalogs (Slovenski filmi / SLOSiNH) alongside the
//    generic Filmi/Serije types.
// 2. Below the install button there is a best-effort "did the app open"
//    detector: clicking Install still navigates to the stremio:// deep
//    link exactly as before (this is what already makes phones offer to
//    open Stremio or Nuvio), but now we also start a short timer and
//    listen for the page losing focus (blur / visibilitychange/pagehide).
//    If focus is lost quickly, that's the OS/browser handing off to an
//    installed app, so we just show a quiet confirmation. If nothing
//    happens within the timeout, we assume neither app is installed on
//    this computer or TV and reveal a fallback panel with direct download
//    links (Stremio, Nuvio) plus a "copy manifest link" button, since
//    Nuvio on desktop/TV is normally added by pasting the https:// link
//    manually rather than via a registered URL scheme.
//
// This can't be a *reliable* installed-app check (browsers don't expose
// that), but the blur/visibilitychange heuristic is the same best-effort
// approach most "open in app" web flows use, and it degrades gracefully:
// worst case, the person just sees the fallback download links a moment
// after clicking Install.

const STYLESHEET = `
* {
	box-sizing: border-box;
}

body,
html {
	margin: 0;
	padding: 0;
	width: 100%;
	min-height: 100%;
}

body {
	padding: 2vh;
	font-size: 2.2vh;
}

html {
	background-size: auto 100%;
	background-size: cover;
	background-position: center center;
	background-repeat: no-repeat;
	box-shadow: inset 0 0 0 2000px rgb(0 0 0 / 60%);
}

body {
	display: flex;
	font-family: 'Open Sans', Arial, sans-serif;
	color: white;
}

h1 {
	font-size: 4.5vh;
	font-weight: 700;
}

h2 {
	font-size: 2.2vh;
	font-weight: normal;
	font-style: italic;
	opacity: 0.8;
}

h3 {
	font-size: 2.2vh;
}

h1,
h2,
h3,
p {
	margin: 0;
	text-shadow: 0 0 1vh rgba(0, 0, 0, 0.15);
}

p {
	font-size: 1.75vh;
}

ul {
	font-size: 1.75vh;
	margin: 0;
	margin-top: 1vh;
	padding-left: 3vh;
}

a {
	color: white
}

a.install-link {
	text-decoration: none
}

button {
	border: 0;
	outline: 0;
	color: white;
	background: #8A5AAB;
	padding: 1.2vh 3.5vh;
	margin: auto;
	text-align: center;
	font-family: 'Open Sans', Arial, sans-serif;
	font-size: 2.2vh;
	font-weight: 600;
	cursor: pointer;
	display: block;
	box-shadow: 0 0.5vh 1vh rgba(0, 0, 0, 0.2);
	transition: box-shadow 0.1s ease-in-out;
}

button:hover {
	box-shadow: none;
}

button:active {
	box-shadow: 0 0 0 0.5vh white inset;
}

#addon {
	width: 40vh;
	margin: auto;
}

.logo {
	height: 14vh;
	width: 14vh;
	margin: auto;
	margin-bottom: 3vh;
}

.logo img {
	width: 100%;
}

.name, .version {
	display: inline-block;
	vertical-align: top;
}

.name {
	line-height: 5vh;
	margin: 0;
}

.version {
	position: relative;
	line-height: 5vh;
	opacity: 0.8;
	margin-bottom: 2vh;
}

.contact {
	position: absolute;
	left: 0;
	bottom: 4vh;
	width: 100%;
	text-align: center;
}

.contact a {
	font-size: 1.4vh;
	font-style: italic;
}

.separator {
	margin-bottom: 4vh;
}

.form-element {
	margin-bottom: 2vh;
}

.label-to-top {
	margin-bottom: 2vh;
}

.label-to-right {
	margin-left: 1vh !important;
}

.full-width {
	width: 100%;
}

.detect-status {
	margin-top: 1.5vh;
	font-size: 1.6vh;
	opacity: 0.85;
	min-height: 2.2vh;
	text-align: center;
}

.fallback {
	margin-top: 1.5vh;
	padding-top: 2vh;
	border-top: 1px solid rgba(255, 255, 255, 0.25);
	text-align: center;
}

.fallback[hidden] {
	display: none;
}

.fallback-text {
	margin-bottom: 1.5vh;
	opacity: 0.9;
}

.fallback-buttons {
	display: flex;
	gap: 1.5vh;
}

.fallback-buttons button.secondary {
	flex: 1;
	background: rgba(255, 255, 255, 0.12);
	font-size: 1.8vh;
	padding: 1vh 1vh;
}

.link-button {
	margin-top: 1.5vh;
	background: transparent;
	box-shadow: none;
	text-decoration: underline;
	font-size: 1.5vh;
	font-weight: normal;
	padding: 0;
}
`;

function renderConfigurePage(manifest) {
  const background = manifest.background || 'https://dl.strem.io/addon-background.jpg';
  const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png';
  const contactHTML = manifest.contactEmail
    ? `<div class="contact">
			<p>Kontakt ustvarjalca ${manifest.name}:</p>
			<a href="mailto:${manifest.contactEmail}">${manifest.contactEmail}</a>
		</div>`
    : '';

  // Hardcoded (not derived from manifest.types) so we can list the two
  // SloFlix-specific catalogs alongside the generic Filmi/Serije types.
  const CATALOG_LIST_ITEMS = [
    'Filmi',
    'Serije',
    'Slovenski filmi',
    'Sinhronizirane risanke in risani filmi',
    'Slovenski podnapisi - tudi za vsebino iz drugih addonov (Torrentio, Comet ...)'
  ];

  let formHTML = '';
  let formScript = '';

  if ((manifest.config || []).length) {
    let options = '';
    manifest.config.forEach((elem) => {
      const key = elem.key;
      if (['text', 'number', 'password'].includes(elem.type)) {
        const isRequired = elem.required ? ' required' : '';
        const defaultHTML = elem.default ? ` value="${elem.default}"` : '';
        const inputType = elem.type;
        options += `
				<div class="form-element">
					<div class="label-to-top">${elem.title}</div>
					<input type="${inputType}" id="${key}" name="${key}" class="full-width"${defaultHTML}${isRequired}/>
				</div>
				`;
      } else if (elem.type === 'checkbox') {
        const isChecked = elem.default === 'checked' ? ' checked' : '';
        options += `
				<div class="form-element">
					<label for="${key}">
						<input type="checkbox" id="${key}" name="${key}"${isChecked}> <span class="label-to-right">${elem.title}</span>
					</label>
				</div>
				`;
      } else if (elem.type === 'select') {
        const defaultValue = elem.default || (elem.options || [])[0];
        options += `<div class="form-element">
				<div class="label-to-top">${elem.title}</div>
				<select id="${key}" name="${key}" class="full-width">
				`;
        const selections = elem.options || [];
        selections.forEach((el) => {
          const isSelected = el === defaultValue ? ' selected' : '';
          options += `<option value="${el}"${isSelected}>${el}</option>`;
        });
        options += `</select>
               </div>
               `;
      }
    });
    if (options.length) {
      formHTML = `
			<form class="pure-form" id="mainForm">
				${options}
			</form>

			<div class="separator"></div>
			`;
    }
  }

  // Client-side: build the stremio:// deep link exactly like the stock SDK
  // template did (so the existing "works nicely on the phone" behaviour is
  // unchanged), but also arm a best-effort detector: if clicking Install
  // doesn't blur/hide the page within DETECT_TIMEOUT_MS, assume neither
  // Stremio nor Nuvio is installed on this computer/TV and show the
  // fallback download panel.
  formScript = `
		var mainForm = document.getElementById('mainForm');
		var installLink = document.getElementById('installLink');
		var detectStatus = document.getElementById('detectStatus');
		var fallback = document.getElementById('fallback');
		var copyLinkBtn = document.getElementById('copyLinkBtn');
		var DETECT_TIMEOUT_MS = 1800;
		var detectTimer = null;

		function currentConfig() {
			if (!mainForm) return null;
			var data = new FormData(mainForm);
			var config = {};
			data.forEach(function (value, key) { config[key] = value; });
			return config;
		}

		function manifestUrl(scheme) {
			var config = currentConfig();
			var configSegment = config ? '/' + encodeURIComponent(JSON.stringify(config)) : '';
			return scheme + '://' + window.location.host + configSegment + '/manifest.json';
		}

		function updateLink() {
			installLink.href = manifestUrl('stremio');
		}

		function clearDetectTimer() {
			if (detectTimer) {
				clearTimeout(detectTimer);
				detectTimer = null;
			}
		}

		function onAppLikelyOpened() {
			if (!detectTimer) return;
			clearDetectTimer();
			fallback.hidden = true;
			detectStatus.textContent = 'Odpira se v Stremio ali Nuvio ...';
		}

		document.addEventListener('visibilitychange', function () {
			if (document.hidden) onAppLikelyOpened();
		});
		window.addEventListener('blur', onAppLikelyOpened);
		window.addEventListener('pagehide', onAppLikelyOpened);

		if (mainForm) {
			mainForm.onchange = updateLink;
			installLink.onclick = function (e) {
				if (!mainForm.reportValidity()) {
					e.preventDefault();
					return;
				}
				armDetector();
			};
		} else {
			installLink.onclick = armDetector;
		}

		function armDetector() {
			updateLink();
			fallback.hidden = true;
			detectStatus.textContent = '';
			clearDetectTimer();
			detectTimer = setTimeout(function () {
				detectTimer = null;
				detectStatus.textContent = '';
				fallback.hidden = false;
			}, DETECT_TIMEOUT_MS);
		}

		if (copyLinkBtn) {
			copyLinkBtn.addEventListener('click', function () {
				var url = manifestUrl('https');
				var done = function () {
					var original = copyLinkBtn.getAttribute('data-original-text') || copyLinkBtn.textContent;
					copyLinkBtn.setAttribute('data-original-text', original);
					copyLinkBtn.textContent = 'Povezava kopirana!';
					setTimeout(function () { copyLinkBtn.textContent = original; }, 2000);
				};
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(url).then(done).catch(function () { window.prompt('Kopirajte povezavo:', url); });
				} else {
					window.prompt('Kopirajte povezavo:', url);
				}
			});
		}

		updateLink();
	`;

  return `
	<!DOCTYPE html>
	<html style="background-image: url(${background});">

	<head>
		<meta charset="utf-8">
		<title>${manifest.name} - Stremio / Nuvio addon</title>
		<style>${STYLESHEET}</style>
		<link rel="shortcut icon" href="${logo}" type="image/x-icon">
		<link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
		<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/purecss@2.1.0/build/pure-min.css" integrity="sha384-yHIFVG6ClnONEA5yB5DJXfW2/KC173DIQrYoZMEtBvGzmf0PKiGyNEqe9N6BNDBH" crossorigin="anonymous">
	</head>

	<body>
		<div id="addon">
			<div class="logo">
			<img src="${logo}">
			</div>
			<h1 class="name">${manifest.name}</h1>
			<h2 class="version">v${manifest.version || '0.0.0'}</h2>
			<h2 class="description">${manifest.description || ''}</h2>

			<div class="separator"></div>

			<h3 class="gives">Ta addon vsebuje:</h3>
			<ul>
			${CATALOG_LIST_ITEMS.map((t) => `<li>${t}</li>`).join('')}
			</ul>

			<div class="separator"></div>

			${formHTML}

			<a id="installLink" class="install-link" href="#">
			<button name="Install">NAMESTI</button>
			</a>

			<div id="detectStatus" class="detect-status"></div>
			<div id="fallback" class="fallback" hidden>
				<p class="fallback-text">Nismo zaznali nameščenega Stremia ali Nuvia na tej napravi (računalnik/TV). Namestite enega izmed njiju:</p>
				<div class="fallback-buttons">
					<a href="https://www.stremio.com/downloads" target="_blank" rel="noopener noreferrer"><button type="button" class="secondary">Prenesi Stremio</button></a>
					<a href="https://nuvio.tv" target="_blank" rel="noopener noreferrer"><button type="button" class="secondary">Prenesi Nuvio</button></a>
				</div>
				<button type="button" id="copyLinkBtn" class="link-button">Kopiraj povezavo addona (za ročno namestitev v Nuvio na TV)</button>
			</div>

			${contactHTML}
		</div>
		<script>
			${formScript}
		</script>
	</body>

	</html>`;
}

export default renderConfigurePage;
