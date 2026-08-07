SELECT s."Shipment_Id", s."Carrier"
FROM "Shipments" s
WHERE s."Delivered_On" IS NULL