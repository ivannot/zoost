SELECT p."Family", COUNT(s."Subscription_Id") AS "Active"
FROM "Subscriptions" s
JOIN "Products" p ON p."Product_Id" = s."Product_Id"
WHERE s."Ends_On" IS NULL
GROUP BY p."Family"
