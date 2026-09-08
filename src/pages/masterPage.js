const CANCELLATION_REQUEST_URL = 'https://therealdesfly.wixforms.com/f/7503041991672857668';
const CANCELLATION_REQUEST_LABEL = 'Request cancellation';
const CANCELLATION_MENU_ID = 'request-order-cancellation';

function containsCancellationLink(items) {
    return items.some((item) => item.id === CANCELLATION_MENU_ID
        || item.link === CANCELLATION_REQUEST_URL
        || (Array.isArray(item.menuItems) && containsCancellationLink(item.menuItems)));
}

function addCancellationMenuLink() {
    const menu = $w('#horizontalMenu2');
    const items = menu.menuItems;
    if (!Array.isArray(items) || containsCancellationLink(items)) return;

    // Wix requires replacing the array; preserve every existing item/submenu.
    menu.menuItems = items.concat({
        id: CANCELLATION_MENU_ID,
        label: CANCELLATION_REQUEST_LABEL,
        link: CANCELLATION_REQUEST_URL,
        target: '_blank',
    });
}

function addCancellationFooterLink() {
    // These are existing Text elements in the generated master-page types.
    // Match the policy label before changing content; never guess a footer ID.
    const textIds = ['#text44', '#text24', '#text32', '#text33', '#text37', '#text25', '#text36'];
    const policyText = textIds.map((id) => $w(id))
        .find((element) => /^refund\s+policy$/i.test(String(element.text || '').trim()));
    if (!policyText || !policyText.html || policyText.html.includes(CANCELLATION_REQUEST_URL)) return;

    // Clone the existing styled paragraph, keeping the original policy intact.
    let requestHtml = policyText.html.replace(/refund(?:\s|&nbsp;|&#160;)+policy/i, CANCELLATION_REQUEST_LABEL);
    if (requestHtml === policyText.html) return;
    if (/<a\b/i.test(requestHtml)) {
        requestHtml = requestHtml.replace(/<a\b[^>]*>/i, (tag) => (
            tag.replace(/\s+(?:href|target)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
                .replace(/>$/, ` href="${CANCELLATION_REQUEST_URL}" target="_blank">`)
        ));
    } else {
        requestHtml = requestHtml.replace(CANCELLATION_REQUEST_LABEL,
            `<a href="${CANCELLATION_REQUEST_URL}" target="_blank">${CANCELLATION_REQUEST_LABEL}</a>`);
    }
    policyText.html = policyText.html + requestHtml;
}

$w.onReady(function () {
    addCancellationMenuLink();
    addCancellationFooterLink();
});
