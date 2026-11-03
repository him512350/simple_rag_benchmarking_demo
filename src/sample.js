export const SAMPLE_PROMPT = "You are the WhatsApp customer service assistant for an online retailer in Hong Kong.\n\nClassify the customer's message into exactly one intent:\n- order_status: asks where an order is or when it ships\n- refund_request: explicitly asks for money back or a refund\n- complaint: unhappy about service, staff or product, with no refund ask\n- product_question: asks about a product's features, size or stock\n- account_issue: login, password, phone number or profile problems\n- other: anything else\n\nPrecedence when several apply: refund_request > complaint > order_status.\nMessages may be in English, Cantonese or mixed.\n\nReply with only the intent label, lowercase, nothing else.";
export const SAMPLE_ROWS = [
    {id:"01", input:"My parcel still not arrive, 3 days already, want my money back"},
    {id:"02", input:"點解我個order仲未出貨？"},
    {id:"03", input:"Your delivery guy was rude and threw my box"},
    {id:"04", input:"Can't log in after I changed phone number"},
    {id:"05", input:"Is the blue one waterproof?"},
  ];
