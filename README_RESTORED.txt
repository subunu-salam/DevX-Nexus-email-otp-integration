DEVX NEXUS — RESTORED BUILD

This build restores the customer/admin functionality from the versions created during this conversation while keeping the existing product, cart, checkout, voice controls, and admin UI intact.

Restored/fixed:
- Middle East country dropdown: UAE/Dubai, Oman, Saudi Arabia, Kuwait, Qatar, Bahrain.
- Country-specific 8/9 digit validation. Error appears only when attempting with an invalid length.
- Numeric-only mobile and PIN inputs.
- Existing number: "Account found. Enter your 4-digit PIN."
- New number: alphabet-only full name + one 4-digit PIN creation.
- No "mobile is locked" message.
- Unsigned users cannot see order history; My Orders shows Sign in only.
- Signed-in users see concise order cards and open details with the arrow/action.
- Additional product / Order Extra flow is restored.
- No automatic Add Products popup/banner.
- Additional products remain attached to the original order.
- Admin Start Preparing endpoint now returns valid JSON and updates customer status.
- Customer-facing wording uses "waiting for approval".

Run:
1. Open the project folder in PowerShell.
2. Run: npm install
3. Run: npm start
4. Open http://localhost:3000
5. Admin: http://localhost:3000/admin

Do not copy an old index.html over this build, otherwise the restored customer features will be overwritten.
