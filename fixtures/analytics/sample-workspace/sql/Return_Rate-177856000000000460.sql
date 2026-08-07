SELECT o."Channel", COUNT(r."Return_Id") AS "Returns"
FROM "Returns" r
JOIN "Orders" o ON o."Order_Id" = r."Order_Id"
GROUP BY o."Channel"