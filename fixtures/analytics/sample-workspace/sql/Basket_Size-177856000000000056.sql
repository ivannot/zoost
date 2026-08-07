SELECT o."Order_Id", SUM(l."Quantity") AS "Units"
FROM "Order_Lines" l
JOIN "Orders" o ON o."Order_Id" = l."Order_Id"
GROUP BY o."Order_Id"
