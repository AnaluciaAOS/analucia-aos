# Putting the website online

For the owner. The site is five files and three language folders in `site/`. They are packed into one file, `analucia-site.zip`, that you upload to your hosting. It runs on any shared hosting with cPanel (Apache); nothing has to be installed.

Where the zip is: `../analucia-lab/site-release/analucia-site.zip` (next to this repository, never inside it). It holds `index.html`, `privacy.html`, `style.css`, `robots.txt`, `.htaccess` and the folders `es/`, `pt/` and `hi/` (one `index.html` each: Spanish, Portuguese and Hindi), with `index.html` at the top level.

## 1. Upload and extract (about 5 minutes)

1. Sign in to cPanel and open **File Manager**.
2. Open the folder **`analuciaaos.com`**: the folder cPanel created for that domain.
3. Turn on hidden files, so you can see `.htaccess`: in File Manager **Settings**, tick "Show Hidden Files (dotfiles)".
4. If the folder already has an old version of the site, select its files and delete them (or move them to a folder named `old`).
5. Click **Upload** and choose `analucia-site.zip`. Wait until it says the upload is complete, then go back to the folder.
6. Select `analucia-site.zip` and click **Extract**, into the same folder `analuciaaos.com`.
7. Check that `index.html` is directly in `analuciaaos.com`, not in a subfolder, and that the folders `es`, `pt` and `hi` are next to it. Then delete `analucia-site.zip` from the server.

## 2. Check it (about 5 minutes)

Open these in a private browser window:

- `http://analuciaaos.com/` shows the page "Hand the work to AI. Keep the decisions."
- The four links at the top (How it works, What you see, Get started, Talk to us) each move to their part of the page.
- "Book a 30-minute diagnostic" opens a new email to `hello@analuciaaos.com`. Next to it the address is written out, and "Copy email" copies it and says "Copied" for a moment (for readers without a mail program). On a computer the button stays at the top while you scroll; on a phone it stays in a bar at the bottom.
- Under "Get started", each "Copy" button copies its command and says "Copied" for a moment; the six steps of the loop open a short example when you click them.
- The language links at the top (English, Español, Português, हिन्दी) open each language page. Check each one:
  - `http://analuciaaos.com/es/index.html` (Spanish), `http://analuciaaos.com/pt/index.html` (Portuguese) and `http://analuciaaos.com/hi/index.html` (Hindi) show the same page in that language, with its colours, a small "under review" notice at the top, and the install commands still in English.
  - The Hindi page shows Devanagari letters, not boxes or question marks.
  - On each language page, "Privacy" opens the English privacy page.
- `http://analuciaaos.com/privacy.html` shows the privacy page with its "Draft" note.
- `http://analuciaaos.com/robots.txt` shows two lines.
- If File Manager shows any folder inside `analuciaaos.com`, open its address (for example `http://analuciaaos.com/<folder>/`): it must **not** show a list of files. A "Forbidden" or "Not found" page is correct.

If the page shows without colours, `style.css` is missing or in the wrong folder: repeat step 1.7.

## 3. Turn on HTTPS (once the certificate shows)

Most cPanel hosts issue a free certificate automatically; it can take a few hours after the domain points to the hosting. Wait until `https://analuciaaos.com/` opens with the padlock and no warning. **Only then** add these lines at the end of `.htaccess` (File Manager, select `.htaccess`, **Edit**, save):

```
RewriteEngine On
RewriteCond %{HTTPS} !=on
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
```

Then check that `http://analuciaaos.com/` moves to `https://analuciaaos.com/` by itself. If the site stops opening, remove the three lines again: the redirect was added before the certificate was ready.

## WhatsApp (switched off until you have a business number)

Each of the four pages has the WhatsApp link wired but switched off. While the number is empty, nothing about WhatsApp is shown. Once set, the "Talk on WhatsApp" link appears next to the contact address: on the Spanish and Portuguese pages for every reader; on the English and Hindi pages only for readers whose computer or phone is set to one of the two time zones named in the page script.

To switch it on, put the number in **one place per page**, in these four files: `index.html`, `es/index.html`, `pt/index.html` and `hi/index.html`. Near the top of each file there is this line:

```
var WHATSAPP_NUMBER = '';
```

Write the number between the quotes, digits only, with the country code and without `+`, spaces or dashes (for example `var WHATSAPP_NUMBER = '15550001234';` for a number written +1 555 000 1234). Use the same number in the four files. You can edit them in cPanel File Manager (select the file, **Edit**, save) or in `site/` and rebuild the zip; if you edit in `site/`, upload the zip again as in step 1. Then open the Spanish page: it shows "Hablar por WhatsApp", and a click opens WhatsApp with a short greeting. To switch it off again, empty the quotes.

The privacy page already says that a WhatsApp conversation is handled by WhatsApp under its own terms.

## Before publishing

- The page text and the privacy draft wait for your review in `aos sign`, where you approve, comment or reject them.
- The Spanish, Portuguese and Hindi pages each say their translation is under review. When a native reader has approved one, remove its notice: in that file, delete the one line that starts with `<p class="wrap transnote" id="translation-note"`.
- The privacy page says "Draft — to be reviewed by the owner's lawyer (ORD-0013)" until your lawyer has read it.
