import mail from "nodemailer";
const createTransport = mail.createTransport.bind(mail);
mail.createTransport = () =>
  createTransport({ host: "127.0.0.1", port: 2525, ignoreTLS: true });
const nativeFetch = globalThis.fetch;
const endpoints = new Map([
  ["https://oauth2.googleapis.com/token", "/token"],
  ["https://openidconnect.googleapis.com/v1/userinfo", "/user"],
  ["https://slack.com/api/oauth.v2.access", "/slack"],
  ["https://hooks.slack.com/services/test/channel", "/message"],
]);
globalThis.fetch = (input, options) =>
  nativeFetch(
    endpoints.has(input)
      ? "http://127.0.0.1:3250" + endpoints.get(input)
      : input,
    options,
  );
