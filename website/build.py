#!/usr/bin/env python3
"""Build the static surecast.live site into website/public/.

Run: python3 website/build.py
Edit business details and prices in SITE / PLANS below, then rebuild.
"""
import re
import shutil
from datetime import date
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "public"
STATIC = ROOT / "static"
ICONS = ROOT / "icons"  # Mono set from the brand kit (08 Iconography/SVG Mono)

# ---------------------------------------------------------------------------
# Business details. Razorpay checks these against the merchant KYC, so they
# must match the registered company exactly. Items in [brackets] need filling.
# ---------------------------------------------------------------------------
SITE = {
    "url": "https://surecast.live",
    "app": "https://app.surecast.live",
    "brand": "Surecast",
    "company": "Exaltes Global Private Limited",
    "address": "[Registered office address, City, State, PIN], India",
    "city": "[City]",
    "email": "support@surecast.live",
    "legal_email": "legal@surecast.live",
    "phone": "[+91 phone number]",
    "hours": "Monday to Friday, 10:00 to 18:00 IST",
    "grievance_officer": "[Grievance Officer name]",
    "updated": "22 October 2026",
}

PLANS = [
    {
        "name": "Solo",
        "for": "Freelancers and in-house marketers",
        "price": "₹799",
        "channels": "10 channels",
        "items": ["1 workspace, up to 3 clients", "10 connected channels", "Unlimited scheduled posts", "2 team seats"],
        "cta": "Start free trial",
    },
    {
        "name": "Agency",
        "for": "Agencies managing client brands",
        "price": "₹2,499",
        "channels": "50 channels",
        "items": ["Unlimited clients", "50 connected channels", "Unlimited team seats", "Unlimited client approval links", "Proof-of-publish reports per client"],
        "cta": "Start free trial",
        "featured": True,
    },
    {
        "name": "Scale",
        "for": "Larger agencies and networks",
        "price": "₹5,999",
        "channels": "200 channels",
        "items": ["Everything in Agency", "200 connected channels", "Priority support, 4-hour response", "Onboarding call"],
        "cta": "Start free trial",
    },
]


def icon(name):
    s = (ICONS / f"{name}.svg").read_text()
    s = re.sub(r"<metadata>.*?</metadata>", "", s, flags=re.S)
    s = s.replace(' xmlns:c2pa="http://c2pa.org/manifest"', "")
    s = re.sub(r'\s(width|height)="24"', "", s)
    return s.replace("<svg ", '<svg aria-hidden="true" focusable="false" ', 1)


def link_app(path):
    return SITE["app"] + path


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

def head(title, description, path):
    canonical = SITE["url"] + path
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<meta name="description" content="{escape(description)}">
<link rel="canonical" href="{canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Surecast">
<meta property="og:title" content="{escape(title)}">
<meta property="og:description" content="{escape(description)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{SITE['url']}/img/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="32x32" href="/brand/Surecast-Icon-Rounded-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/Surecast-Icon-Rounded-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/Surecast-Icon-Rounded-180.png">
<link rel="manifest" href="/brand/site.webmanifest">
<meta name="theme-color" content="#111827">
<link rel="preload" href="/fonts/Archivo-ExtraBold.ttf" as="font" type="font/ttf" crossorigin>
<link rel="preload" href="/fonts/Figtree-Regular.ttf" as="font" type="font/ttf" crossorigin>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
"""


def header(home=True):
    p = "" if home else "/"
    return f"""<header class="site-header">
  <div class="wrap">
    <a class="logo" href="/" aria-label="Surecast home"><img src="/brand/Surecast-Logo-Horizontal-Color.svg" alt="Surecast" width="145" height="30"></a>
    <nav class="nav" aria-label="Main">
      <a href="{p}#features">Features</a>
      <a href="{p}#how">How it works</a>
      <a href="{p}#compare">Compare</a>
      <a href="{p}#pricing">Pricing</a>
      <a href="{p}#faq">FAQ</a>
    </nav>
    <div class="header-cta">
      <a class="login" href="{link_app('/login')}">Log in</a>
      <a class="btn btn-ink btn-sm" href="{link_app('/signup')}">Start free</a>
    </div>
  </div>
</header>
"""


def footer():
    year = date.today().year
    return f"""<footer class="site-footer">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <img src="/brand/Surecast-Logo-Horizontal-Reverse.svg" alt="Surecast" width="135" height="28">
        <p>Every post goes out. Or you know why.</p>
        <p>Surecast is a product of {SITE['company']}.</p>
      </div>
      <div>
        <h4>Product</h4>
        <ul>
          <li><a href="/#features">Features</a></li>
          <li><a href="/#pricing">Pricing</a></li>
          <li><a href="/#compare">Compare</a></li>
          <li><a href="{link_app('/login')}">Log in</a></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <li><a href="/contact/">Contact us</a></li>
          <li><a href="mailto:{SITE['email']}">{SITE['email']}</a></li>
        </ul>
      </div>
      <div>
        <h4>Policies</h4>
        <ul>
          <li><a href="/terms/">Terms and conditions</a></li>
          <li><a href="/privacy/">Privacy policy</a></li>
          <li><a href="/refund-policy/">Cancellation and refunds</a></li>
          <li><a href="/shipping-policy/">Shipping and delivery</a></li>
        </ul>
      </div>
    </div>
    <div class="foot-bottom">
      <span>&copy; {year} {SITE['company']}. All rights reserved.</span>
      <span>Prices in Indian Rupees. Payments processed securely by Razorpay.</span>
    </div>
  </div>
</footer>
</body>
</html>
"""


def page(path, title, description, body, home=False):
    return head(title, description, path) + header(home) + f'<main id="main">\n{body}\n</main>\n' + footer()


def legal(path, title, description, intro, content):
    body = f"""<div class="page-head"><div class="wrap">
  <h1>{title}</h1>
  <p>{intro}</p>
</div></div>
<article class="prose">
{content}
</article>"""
    return page(path, f"{title} | Surecast", description, body)


# ---------------------------------------------------------------------------
# Home
# ---------------------------------------------------------------------------

FEATURES = [
    ("sc-retry", "Automatic retry", "Rate limits, timeouts and platform hiccups are retried with backoff. Every attempt is logged, so you can see exactly what happened.", True),
    ("sc-health", "Pre-flight checks", "Fifteen minutes before each slot we check the token, the media and the text limits. Problems reach you before the post is due, not after.", True),
    ("sc-token-alert", "Token-expiry alerts", "Connections that are about to expire are flagged days ahead, with a one-click reconnect. No more silent disconnects.", True),
    ("sc-failed", "Failures in plain language", "Instead of an error code you get the cause and the fix, for example: Instagram token expired, reconnect this channel.", False),
    ("sc-scheduled", "Missed-slot watchdog", "Anything that should have gone out and has not is caught and raised, even if the platform never replied.", False),
    ("sc-analytics", "One health dashboard", "Posts out today, failures that need action and channels at risk, across every client, on one screen.", False),
    ("sc-approval", "Client approvals", "Send a link and your client approves or requests changes. No login, no extra seat, no extra cost.", False),
    ("sc-proof-report", "Proof-of-publish reports", "A monthly report per client listing every post, when it went out and its live link. Share it or print it.", False),
    ("sc-ai-draft", "AI drafting and API", "Draft and adapt captions per platform with AI, and plug Surecast into your own tools with the API and webhooks.", False),
]

FAQ = [
    ("Which platforms does Surecast support?", "Bluesky, Mastodon and Telegram channels work today. LinkedIn, Facebook Pages, Instagram Business and X are built and are being switched on as each platform completes its app review. TikTok, YouTube, Threads, Pinterest and Google Business Profile are next."),
    ("What happens when a post fails?", "Temporary errors such as rate limits or timeouts are retried automatically. If a post cannot go out, for example because a token expired, it stops at once and you get an email with the reason and the fix. The attempt log on the post shows every try."),
    ("Is there a free trial?", "Yes. Every plan starts with a 14-day free trial with all features. You will not be charged until the trial ends, and you can cancel at any time before that."),
    ("Do you charge per social account?", "No. Each plan includes a fixed number of channels and unlimited posts. Client approval links never use a seat."),
    ("Can I cancel any time?", "Yes. Cancel from Billing in the app. Your plan stays active until the end of the period you paid for and does not renew. See our cancellation and refund policy for details."),
    ("Where is my data stored?", "Your workspace data and media are stored on our servers and are never sold. You can export or delete your data at any time. Read the privacy policy for the full picture."),
    ("How do I pay?", "We accept UPI, debit and credit cards, net banking and wallets through Razorpay. Prices are in Indian Rupees and GST is added at checkout where it applies."),
]


def home():
    feats = "\n".join(
        f"""<div class="feature{' core' if core else ''}"><div class="ico">{icon(ic)}</div><h3>{escape(t)}</h3><p>{escape(d)}</p></div>"""
        for ic, t, d, core in FEATURES
    )
    plans = ""
    for p in PLANS:
        items = "".join(f"<li>{escape(i)}</li>" for i in p["items"])
        featured = p.get("featured")
        plans += f"""<div class="plan{' featured' if featured else ''}">
  {'<span class="badge">Most popular</span>' if featured else ''}
  <h3>{p['name']}</h3>
  <p class="for">{p['for']}</p>
  <div class="price">{p['price']}<small> / month</small></div>
  <p class="price-sub">Billed monthly, plus GST. {p['channels']}.</p>
  <ul>{items}</ul>
  <a class="btn {'btn-primary' if featured else 'btn-ink'}" href="{link_app('/signup?plan=' + p['name'].lower())}">{p['cta']}</a>
</div>
"""
    faq = "\n".join(f"<details><summary>{escape(q)}</summary><p>{escape(a)}</p></details>" for q, a in FAQ)

    compare_rows = [
        ("Pricing", "Flat plans with a set number of channels", "Often per account or per seat, so cost climbs with every client"),
        ("Client approvals", "Unlimited approval links, no seat needed", "Usually needs a paid seat or a higher tier"),
        ("Before the slot", "Pre-flight check on token, media and text limits", "Problems surface only when the post fails"),
        ("When a post fails", "Automatic retry, full attempt log, plain-language fix", "A generic error, sometimes with no alert at all"),
        ("Expiring connections", "Alerts days ahead with one-click reconnect", "Found out when posts stop going out"),
        ("Proof for clients", "Monthly proof-of-publish report with live links", "Screenshots or manual spreadsheets"),
        ("API and webhooks", "Included on every plan", "Often locked to the top tier"),
    ]
    rows = "\n".join(
        f'<tr><th scope="row">{a}</th><td class="us"><span class="yes">&#10003;</span> {b}</td><td class="muted">{c}</td></tr>'
        for a, b, c in compare_rows
    )

    body = f"""
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <span class="eyebrow">Social media scheduling for agencies</span>
      <h1>Every post goes out. <span class="accent">Or you know why.</span></h1>
      <p class="lede">Surecast is the reliability-first scheduler for agencies and social media teams. Automatic retries, pre-flight checks, expiry alerts and proof-of-publish reports for every client.</p>
      <div class="hero-ctas">
        <a class="btn btn-primary" href="{link_app('/signup')}">Start your 14-day free trial</a>
        <a class="btn btn-ghost" href="#how">See how it works</a>
      </div>
      <p class="fine">No card needed for the trial. Cancel any time.</p>
    </div>
    <div class="mock" role="img" aria-label="Example Surecast health dashboard showing 42 posts out today, 1 needing action and channel statuses">
      <div class="mock-top"><span class="mock-title">Health today</span><span class="mock-date">Thu 22 Oct</span></div>
      <div class="mock-stats">
        <div class="stat"><b>42</b><span>Posts out</span></div>
        <div class="stat"><b>3</b><span>Retried, then posted</span></div>
        <div class="stat warn"><b>1</b><span>Needs action</span></div>
      </div>
      <ul class="mock-list">
        <li><span class="chan" style="background:#0A66C2">in</span><span class="who"><b>Bloom Bakery · LinkedIn</b><small>Posted 09:00, live link saved</small></span><span class="pill ok">Posted</span></li>
        <li><span class="chan" style="background:#E1306C">IG</span><span class="who"><b>Kite Studio · Instagram</b><small>Timeout at 10:30, posted on retry 2</small></span><span class="pill retry">Retried</span></li>
        <li><span class="chan" style="background:#1877F2">f</span><span class="who"><b>Northside Gym · Facebook</b><small>Token expires in 5 days</small></span><span class="pill warn">Reconnect</span></li>
        <li><span class="chan" style="background:#111827;border:1px solid #273042">X</span><span class="who"><b>Kite Studio · X</b><small>Image over 5 MB, caught at pre-flight</small></span><span class="pill fail">Fix before 14:00</span></li>
      </ul>
    </div>
  </div>
</section>

<div class="platforms">
  <div class="wrap">
    <span class="label">Publish to</span>
    <span class="tag">Bluesky</span><span class="tag">Mastodon</span><span class="tag">Telegram</span>
    <span class="tag">LinkedIn</span><span class="tag">Facebook</span><span class="tag">Instagram</span><span class="tag">X</span>
    <span class="tag soon">TikTok, YouTube, Threads and more soon</span>
  </div>
</div>

<section class="section" id="problem">
  <div class="wrap">
    <div class="section-head">
      <span class="kicker">The problem</span>
      <h2>Schedulers fail quietly. Your clients notice first.</h2>
      <p>Most tools treat publishing as a solved problem. Anyone running client accounts knows it is not.</p>
    </div>
    <div class="problem-grid">
      <div class="problem"><span class="num">01</span><h3>Silent failures</h3><p>A token expires or a platform times out, and the post simply does not go out. Nobody is told until the client asks.</p></div>
      <div class="problem"><span class="num">02</span><h3>Pricing that punishes growth</h3><p>Per-account and per-seat pricing means every new client makes your tools more expensive, not your agency more profitable.</p></div>
      <div class="problem"><span class="num">03</span><h3>No proof of work</h3><p>When a client asks what went out last month, you are stuck stitching together screenshots from five platforms.</p></div>
    </div>
  </div>
</section>

<section class="section alt" id="features">
  <div class="wrap">
    <div class="section-head">
      <span class="kicker">Features</span>
      <h2>Built around one promise.</h2>
      <p>Everything a good scheduler does, plus a publishing engine that treats every post as something that has to land.</p>
    </div>
    <div class="features">
{feats}
    </div>
  </div>
</section>

<section class="section" id="how">
  <div class="wrap">
    <div class="section-head">
      <span class="kicker">How it works</span>
      <h2>Set it up once. Stop checking.</h2>
    </div>
    <div class="steps">
      <div class="step"><h3>Connect your clients</h3><p>Add each client and connect their channels. Surecast starts watching the health of every connection straight away.</p></div>
      <div class="step"><h3>Compose and schedule</h3><p>Write once, adjust per platform, send for approval and drop it on the calendar in the client's own time zone.</p></div>
      <div class="step"><h3>Know what happened</h3><p>Posts go out with retries and pre-flight checks behind them. If something needs you, you hear about it first, with the fix.</p></div>
    </div>
  </div>
</section>

<section class="section alt" id="compare">
  <div class="wrap">
    <div class="section-head">
      <span class="kicker">Compare</span>
      <h2>Surecast and the usual schedulers.</h2>
      <p>Tools like Publer, Postiz and Postly are good at calendars. Surecast is built for the part that hurts agencies most: knowing every post landed.</p>
    </div>
    <div class="table-wrap">
      <table class="compare">
        <thead><tr><th scope="col"></th><th scope="col" class="us">Surecast</th><th scope="col">Typical scheduler</th></tr></thead>
        <tbody>
{rows}
        </tbody>
      </table>
    </div>
    <p class="note">Based on public pricing pages and user reviews as of October 2026. Features vary by plan and change over time.</p>
  </div>
</section>

<section class="section" id="pricing">
  <div class="wrap">
    <div class="section-head center">
      <span class="kicker">Pricing</span>
      <h2>Flat plans. Every feature on every plan.</h2>
    </div>
    <p class="billing-note">All prices in Indian Rupees, billed monthly. GST is added at checkout where applicable.</p>
    <div class="plans">
{plans}
    </div>
    <p class="all-plans">Every plan includes retries, pre-flight checks, alerts, approvals, proof reports, AI drafting, API and webhooks. 14-day free trial. Cancel any time. <a href="/refund-policy/">Refund policy</a>.</p>
  </div>
</section>

<section class="section alt" id="faq">
  <div class="wrap">
    <div class="section-head center">
      <span class="kicker">FAQ</span>
      <h2>Questions, answered.</h2>
    </div>
    <div class="faq">
{faq}
    </div>
  </div>
</section>

<section class="cta-band">
  <div class="wrap">
    <h2>Stop wondering if it went out.</h2>
    <p>Try Surecast free for 14 days with every feature switched on.</p>
    <div class="btns">
      <a class="btn btn-ink" href="{link_app('/signup')}">Start free trial</a>
      <a class="btn btn-ghost" href="/contact/">Talk to us</a>
    </div>
  </div>
</section>
"""
    return page("/", "Surecast | Every post goes out. Or you know why.",
                "Surecast is the reliability-first social media scheduler for agencies: automatic retries, pre-flight checks, token-expiry alerts and proof-of-publish reports.",
                body, home=True)


# ---------------------------------------------------------------------------
# Policy pages (Razorpay website requirements)
# ---------------------------------------------------------------------------
S = SITE
CO = S["company"]


def contact():
    content = f"""
<p>We are happy to help with questions about Surecast, your account, billing or a payment.</p>
<div class="contact-cards">
  <div class="contact-card"><h3>Email support</h3><p><a href="mailto:{S['email']}">{S['email']}</a><br>We reply within one business day.</p></div>
  <div class="contact-card"><h3>Phone</h3><p>{S['phone']}<br>{S['hours']}</p></div>
  <div class="contact-card"><h3>Billing and payments</h3><p><a href="mailto:{S['email']}?subject=Billing">{S['email']}</a><br>Include your account email and the Razorpay payment ID.</p></div>
  <div class="contact-card"><h3>Legal and privacy</h3><p><a href="mailto:{S['legal_email']}">{S['legal_email']}</a><br>Grievance Officer: {S['grievance_officer']}</p></div>
</div>
<h2>Registered office</h2>
<p><strong>{CO}</strong><br>{S['address']}</p>
<h2>Operating hours</h2>
<p>{S['hours']}, excluding public holidays in India. The Surecast service itself runs 24 hours a day.</p>
"""
    return legal("/contact/", "Contact us", "Contact Surecast support, billing and legal teams.", "Reach the Surecast team by email or phone.", content)


def terms():
    content = f"""
<p class="callout">Last updated: {S['updated']}</p>
<p>These Terms and Conditions ("Terms") govern your use of the Surecast website at surecast.live and the Surecast application at app.surecast.live (together, the "Service"). The Service is operated by <strong>{CO}</strong>, a company incorporated in India with its registered office at {S['address']} ("Surecast", "we", "us"). By creating an account or using the Service you agree to these Terms. If you use the Service for a business, you confirm you are authorised to accept these Terms on its behalf.</p>

<h2>1. The Service</h2>
<p>Surecast is a software-as-a-service tool for planning, approving, scheduling and publishing content to third-party social media platforms, and for monitoring whether that content was published. The Service is delivered online. No physical goods are sold or shipped.</p>

<h2>2. Accounts</h2>
<ul>
  <li>You must be at least 18 years old and give accurate information when you sign up.</li>
  <li>You are responsible for activity under your account and for keeping your login secure. Tell us at once at {S['email']} if you suspect unauthorised access.</li>
  <li>You may invite team members and share approval links with your clients. You are responsible for their use of the Service through your account.</li>
</ul>

<h2>3. Connected platforms</h2>
<p>When you connect a social media account, you authorise Surecast to act on that account as needed to provide the Service, such as publishing posts you schedule. Your use of each platform remains subject to that platform's own terms and policies. Platforms may change or limit their APIs, revoke access tokens, reject content or experience outages. We work to detect and report these events, but we cannot guarantee that a third-party platform will accept or display any post.</p>

<h2>4. Your content</h2>
<p>You keep all rights to the text, images, video and other content you upload ("Your Content"). You grant us a limited licence to store, process, transmit and display Your Content only to provide the Service to you. You confirm you have the rights needed to publish Your Content and that it does not break any law or third-party rights.</p>

<h2>5. Acceptable use</h2>
<p>You agree not to use the Service to:</p>
<ul>
  <li>publish spam, malware, or content that is unlawful, defamatory, obscene, hateful or infringing;</li>
  <li>break the terms of any connected platform, including rules on automation and inauthentic behaviour;</li>
  <li>try to gain unauthorised access to the Service, other accounts or our systems, or disrupt the Service;</li>
  <li>resell or sublicense the Service except as allowed by your plan.</li>
</ul>
<p>We may suspend or remove content or accounts that break this section.</p>

<h2>6. Plans, trials and payment</h2>
<ul>
  <li>Paid plans are billed in advance in Indian Rupees (INR) on a monthly basis at the prices shown on our <a href="/#pricing">pricing section</a> at the time of purchase. GST and other applicable taxes are added at checkout.</li>
  <li>New accounts get a 14-day free trial. If you add a payment method and do not cancel before the trial ends, your plan starts and the first payment is taken.</li>
  <li>Payments are processed by Razorpay Software Private Limited. We do not store your full card, UPI or bank details. Your payment is also subject to Razorpay's terms.</li>
  <li>Subscriptions renew automatically at the end of each billing period until cancelled. We will tell you at least 30 days before any price change takes effect on your plan.</li>
  <li>If a payment fails, we may retry it and may limit your account to read-only access until the balance is paid.</li>
</ul>

<h2>7. Cancellation and refunds</h2>
<p>You can cancel at any time. Refunds are handled under our <a href="/refund-policy/">Cancellation and Refund Policy</a>, which forms part of these Terms.</p>

<h2>8. Availability and support</h2>
<p>We aim to keep the Service available at all times, apart from planned maintenance, which we announce in advance where possible. Support is available by email at {S['email']}.</p>

<h2>9. Intellectual property</h2>
<p>The Service, including its software, design, the Surecast name and logo, belongs to {CO} or its licensors. These Terms do not give you any right to use our trademarks.</p>

<h2>10. Disclaimers</h2>
<p>Except as stated in these Terms, the Service is provided "as is" and "as available". To the extent allowed by law, we disclaim implied warranties of merchantability, fitness for a particular purpose and non-infringement. Social media results such as reach and engagement are not guaranteed.</p>

<h2>11. Limitation of liability</h2>
<p>To the extent allowed by law, we are not liable for indirect, incidental, special or consequential losses, or for loss of profits, revenue, data or goodwill. Our total liability arising out of or relating to the Service in any 12-month period is limited to the amount you paid us for the Service in that period.</p>

<h2>12. Indemnity</h2>
<p>You agree to indemnify us against claims arising from Your Content or your breach of these Terms or of any connected platform's terms.</p>

<h2>13. Termination</h2>
<p>You may close your account at any time. We may suspend or end your access if you materially breach these Terms, with notice where reasonable. After closure you can request an export of your data for 30 days, after which it is deleted as described in our <a href="/privacy/">Privacy Policy</a>.</p>

<h2>14. Changes to these Terms</h2>
<p>We may update these Terms. If a change is material we will tell you by email or in the app at least 15 days before it takes effect. Continuing to use the Service after that date means you accept the updated Terms.</p>

<h2>15. Governing law and disputes</h2>
<p>These Terms are governed by the laws of India. The courts at {S['city']}, India have exclusive jurisdiction over any dispute arising from them. Before going to court, please contact us at {S['legal_email']} so we can try to resolve the issue.</p>

<h2>16. Contact</h2>
<p>{CO}<br>{S['address']}<br>Email: <a href="mailto:{S['legal_email']}">{S['legal_email']}</a> · Phone: {S['phone']}</p>
"""
    return legal("/terms/", "Terms and conditions", "The terms that govern use of Surecast.", "The agreement between you and " + CO + " for using Surecast.", content)


def privacy():
    content = f"""
<p class="callout">Last updated: {S['updated']}</p>
<p>This Privacy Policy explains how <strong>{CO}</strong> ("Surecast", "we", "us") collects, uses and protects personal data when you use surecast.live and app.surecast.live (the "Service"). We process personal data in line with the Digital Personal Data Protection Act, 2023 and the Information Technology Act, 2000 and rules made under them.</p>

<h2>1. Data we collect</h2>
<table>
  <tr><th>Category</th><th>Examples</th></tr>
  <tr><td>Account data</td><td>Name, email address, company name, team members you invite.</td></tr>
  <tr><td>Connected account data</td><td>Access tokens and basic profile details (name, handle, page ID) for social accounts you connect.</td></tr>
  <tr><td>Content</td><td>Posts, captions, images, video, approval comments and schedules you create.</td></tr>
  <tr><td>Billing data</td><td>Plan, invoices, GSTIN if provided, and payment status from Razorpay. We do not receive or store full card numbers, UPI PINs or bank passwords.</td></tr>
  <tr><td>Usage and device data</td><td>Log data such as IP address, browser type, pages visited and error logs, used to run and secure the Service.</td></tr>
  <tr><td>Support data</td><td>Messages you send us and our replies.</td></tr>
</table>

<h2>2. How we use it</h2>
<ul>
  <li>To provide the Service: publishing your scheduled posts, health checks, alerts and reports.</li>
  <li>To process payments, issue invoices and meet tax and accounting obligations.</li>
  <li>To send service emails such as login codes, failure alerts and billing notices.</li>
  <li>To keep the Service secure, prevent abuse and fix problems.</li>
  <li>To improve the Service using aggregated usage information.</li>
  <li>To send product news, only if you opt in. You can unsubscribe at any time.</li>
</ul>
<p>We process your data on the basis of your consent, to perform our contract with you, and to comply with law. We do not sell personal data.</p>

<h2>3. AI features</h2>
<p>If you use AI drafting, the text you provide is sent to our AI provider to generate suggestions. It is used only to return results to you and is not used by us to train models.</p>

<h2>4. Sharing</h2>
<p>We share data only with:</p>
<ul>
  <li>the social platforms you connect, to publish your content;</li>
  <li>service providers that help us run the Service, such as hosting (Hostinger), payments (Razorpay), email delivery and AI processing, under contracts that require them to protect your data;</li>
  <li>authorities, where the law requires it.</li>
</ul>

<h2>5. Storage and security</h2>
<p>Data is stored on secured servers. Access tokens are encrypted, connections use HTTPS, and staff access is limited to what is needed. Some providers may process data outside India; where they do, we take steps to keep it protected.</p>

<h2>6. Retention</h2>
<p>We keep account data while your account is active. After you close your account, we delete your content and connected account tokens within 30 days, except billing records we must keep under tax law (generally 8 years).</p>

<h2>7. Your rights</h2>
<p>You may ask to access, correct, update or erase your personal data, withdraw consent, or nominate another person to exercise these rights. Email <a href="mailto:{S['legal_email']}">{S['legal_email']}</a>. We reply within 30 days.</p>

<h2>8. Cookies</h2>
<p>The website uses only essential cookies. The app uses cookies to keep you signed in. We do not use advertising cookies.</p>

<h2>9. Children</h2>
<p>The Service is not meant for anyone under 18, and we do not knowingly collect their data.</p>

<h2>10. Grievance Officer</h2>
<p>{S['grievance_officer']}, Grievance Officer<br>{CO}, {S['address']}<br>Email: <a href="mailto:{S['legal_email']}">{S['legal_email']}</a></p>

<h2>11. Changes</h2>
<p>We will post any changes on this page and tell you by email if they are material.</p>
"""
    return legal("/privacy/", "Privacy policy", "How Surecast collects, uses and protects your personal data.", "How we collect, use and protect your data.", content)


def refund():
    content = f"""
<p class="callout">Last updated: {S['updated']}</p>
<p>This policy explains how cancellations and refunds work for Surecast subscriptions sold by <strong>{CO}</strong>.</p>

<h2>Free trial</h2>
<p>Every new account starts with a 14-day free trial with all features. You are not charged during the trial. If you cancel before it ends, you will not be charged at all.</p>

<h2>Cancelling your subscription</h2>
<ul>
  <li>You can cancel at any time from <strong>Settings &rarr; Billing</strong> in the app, or by emailing <a href="mailto:{S['email']}">{S['email']}</a> from your account email.</li>
  <li>Cancellation stops future renewals. Your plan stays active until the end of the billing period you have already paid for.</li>
  <li>We confirm every cancellation by email.</li>
</ul>

<h2>Refunds</h2>
<ul>
  <li><strong>First payment:</strong> if you are not happy, ask for a refund within 7 days of your first paid charge and we will refund it in full.</li>
  <li><strong>Renewals:</strong> renewal payments are not refunded for partly used periods. If you forgot to cancel and have not used the Service since the renewal, write to us within 7 days of the charge and we will refund it.</li>
  <li><strong>Duplicate or incorrect charges:</strong> refunded in full once confirmed.</li>
  <li><strong>Service failure:</strong> if the Service is unavailable for more than 24 consecutive hours because of a fault on our side, you can ask for a pro-rata credit or refund for that time.</li>
  <li>Plan downgrades take effect at the next billing date and do not create a refund for the current period.</li>
</ul>

<h2>How to ask for a refund</h2>
<p>Email <a href="mailto:{S['email']}?subject=Refund%20request">{S['email']}</a> with your account email, the date of the charge and the Razorpay payment ID if you have it. We reply within 2 business days.</p>

<h2>Refund timelines</h2>
<p>Approved refunds are processed within 5 to 7 business days and returned to the original payment method through Razorpay. Your bank or card issuer may take a few more days to show the credit.</p>

<h2>Contact</h2>
<p>{CO}<br>{S['address']}<br>Email: <a href="mailto:{S['email']}">{S['email']}</a> · Phone: {S['phone']}</p>
"""
    return legal("/refund-policy/", "Cancellation and refund policy", "How to cancel a Surecast subscription and how refunds work.", "How to cancel and how refunds work.", content)


def shipping():
    content = f"""
<p class="callout">Last updated: {S['updated']}</p>
<p>Surecast is an online software service sold by <strong>{CO}</strong>. <strong>We do not sell or ship any physical products.</strong></p>

<h2>How the Service is delivered</h2>
<ul>
  <li>After you sign up, your Surecast account is available immediately at <a href="{S['app']}">app.surecast.live</a>.</li>
  <li>When you buy or upgrade a plan, the new plan is applied to your account as soon as the payment is confirmed, usually within a few minutes.</li>
  <li>A confirmation and a GST invoice are sent to your account email.</li>
</ul>

<h2>Delivery charges</h2>
<p>There are no shipping or delivery charges.</p>

<h2>If your plan is not activated</h2>
<p>If your payment succeeded but your plan has not changed within 2 hours, email <a href="mailto:{S['email']}">{S['email']}</a> with your account email and Razorpay payment ID. We will activate it or refund the payment within 2 business days.</p>

<h2>Service area</h2>
<p>The Service can be used from anywhere with an internet connection, subject to applicable law and the availability of the connected social platforms.</p>

<h2>Contact</h2>
<p>{CO}<br>{S['address']}<br>Email: <a href="mailto:{S['email']}">{S['email']}</a> · Phone: {S['phone']}</p>
"""
    return legal("/shipping-policy/", "Shipping and delivery policy", "Surecast is an online service with instant digital delivery and no physical shipping.", "Surecast is delivered online. Nothing is shipped.", content)


def not_found():
    body = """<div class="page-head"><div class="wrap"><h1>Page not found</h1><p>That page has gone out, and we know why: it does not exist.</p></div></div>
<article class="prose"><p><a class="btn btn-ink" href="/">Back to the home page</a></p></article>"""
    return page("/404.html", "Page not found | Surecast", "Page not found.", body)


HTACCESS = """# surecast.live static site
ErrorDocument 404 /404.html
DirectoryIndex index.html
Options -Indexes

<IfModule mod_rewrite.c>
RewriteEngine On
# Force HTTPS and the bare domain
RewriteCond %{HTTPS} !=on [OR]
RewriteCond %{HTTP_HOST} ^www\\. [NC]
RewriteRule ^ https://surecast.live%{REQUEST_URI} [L,R=301]
# Old/short URLs
RewriteRule ^(login|signin)/?$ https://app.surecast.live/login [L,R=302]
RewriteRule ^(signup|register)/?$ https://app.surecast.live/signup [L,R=302]
RewriteRule ^pricing/?$ /#pricing [NE,L,R=301]
</IfModule>

<IfModule mod_headers.c>
Header set X-Content-Type-Options "nosniff"
Header set Referrer-Policy "strict-origin-when-cross-origin"
Header set X-Frame-Options "SAMEORIGIN"
<FilesMatch "\\.(ttf|woff2|png|svg|ico|webmanifest)$">
Header set Cache-Control "public, max-age=31536000, immutable"
</FilesMatch>
<FilesMatch "\\.(html|css)$">
Header set Cache-Control "public, max-age=3600"
</FilesMatch>
</IfModule>

<IfModule mod_deflate.c>
AddOutputFilterByType DEFLATE text/html text/css image/svg+xml application/manifest+json font/ttf
</IfModule>
"""


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(STATIC, OUT)
    pages = {
        "index.html": home(),
        "contact/index.html": contact(),
        "terms/index.html": terms(),
        "privacy/index.html": privacy(),
        "refund-policy/index.html": refund(),
        "shipping-policy/index.html": shipping(),
        "404.html": not_found(),
    }
    for rel, html in pages.items():
        f = OUT / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(html)
    (OUT / ".htaccess").write_text(HTACCESS)
    (OUT / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITE['url']}/sitemap.xml\n")
    urls = ["/", "/contact/", "/terms/", "/privacy/", "/refund-policy/", "/shipping-policy/"]
    sm = "".join(f"<url><loc>{SITE['url']}{u}</loc></url>" for u in urls)
    (OUT / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{sm}</urlset>\n')
    print(f"Built {len(pages)} pages into {OUT}")


if __name__ == "__main__":
    main()
