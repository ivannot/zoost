// Sample function - invented, and never run against anything.
module.exports = async function (context, basicIO) {
  const order = basicIO.getParameter("orderId") || "none";
  basicIO.write(`shipment ${order} notified`);
};
