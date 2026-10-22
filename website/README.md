# surecast.live landing page

Static marketing site for Surecast. The app lives at app.surecast.live; every login and signup link points there.

- `build.py` holds the page content, business details (`SITE`) and prices (`PLANS`).
- `static/` holds CSS, fonts, logos and favicons from the brand kit. `icons/` is the Mono icon set.
- `public/` is the built site. It is committed so it can be uploaded as-is.

## Build

    python3 website/build.py

## Razorpay pages

Razorpay checks for these before activating a website: Contact (`/contact/`), Terms (`/terms/`), Privacy (`/privacy/`), Cancellation and Refunds (`/refund-policy/`), Shipping and Delivery (`/shipping-policy/`), plus visible prices (`/#pricing`). All are linked from the footer of every page. The company name, address and phone in `SITE` must match the Razorpay KYC.

## Deploy (Hostinger)

Upload the contents of `public/` (including `.htaccess`) to `public_html` of the surecast.live website in hPanel. The `.htaccess` forces HTTPS, drops `www`, and redirects `/login` and `/signup` to the app.

## Deploy (Hostinger)

Live at https://surecast.live since 2026-10-22. To redeploy: rebuild, zip the contents of `public/`, put the zip in public_html and run "Deploy static site archive" on it (it replaces public_html).
