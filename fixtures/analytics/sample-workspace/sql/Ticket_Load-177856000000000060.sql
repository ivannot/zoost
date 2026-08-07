SELECT a."Segment", COUNT(t."Ticket_Id") AS "Tickets"
FROM "Tickets" t
JOIN "Accounts" a ON a."Account_Id" = t."Account_Id"
GROUP BY a."Segment"
