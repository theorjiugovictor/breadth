import axios from "axios";

export async function sendConfirmation(customerId: string, orderId: string, total: number): Promise<void> {
  await axios.post("https://api.sendgrid.com/v3/mail/send", {
    to: customerId,
    subject: `Order ${orderId} confirmed`,
    text: `Thanks! You paid ${total} EUR.`,
  });
}
