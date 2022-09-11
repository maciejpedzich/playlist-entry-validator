module.exports = (app) => {
  app.onAny((context) => console.log(JSON.stringify(context, null, 2)));
};
