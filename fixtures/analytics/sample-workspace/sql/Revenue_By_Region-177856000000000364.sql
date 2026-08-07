SELECT r."Country", SUM(o."Net_Amount") AS "Revenue"
FROM "Orders" o
JOIN "Accounts" a ON a."Account_Id" = o."Account_Id"
JOIN "Regions" r ON r."Region" = a."Region"
GROUP BY r."Country"