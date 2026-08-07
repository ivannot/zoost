SELECT i."Invoice_Id", i."Due_On", i."Gross_Amount"
FROM "Invoices" i
LEFT JOIN "Payments" p ON p."Invoice_Id" = i."Invoice_Id"
WHERE p."Payment_Id" IS NULL
