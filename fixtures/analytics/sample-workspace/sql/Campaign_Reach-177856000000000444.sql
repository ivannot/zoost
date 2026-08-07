SELECT c."Campaign_Name", COUNT(DISTINCT t."Contact_Id") AS "Reached"
FROM "Touchpoints" t
JOIN "Campaigns" c ON c."Campaign_Id" = t."Campaign_Id"
GROUP BY c."Campaign_Name"