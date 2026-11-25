(function () {
  "use strict";
  const isLocalDev = window.location.port === "8080";
  window.APP_CONFIG = {
    API_BASE_URL: isLocalDev ? "" : "http://56740348ff.execute-api.localhost.floci.io:4566",
    ENV_LABEL: isLocalDev ? "Live Proxy (:8080)" : "Floci API Gateway (:4566)",
    MOCK_COURSES: []
  };
})();
