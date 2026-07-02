import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary.tsx";
import { I18nProvider } from "./contexts/I18nContext.tsx";
import { ThemeProvider } from "./contexts/ThemeContext.tsx";
import "./index.css";

document.documentElement.dataset.platform = /mac/i.test(navigator.platform) ? "macos" : "other";

// Surface async crashes the error boundary can't catch (event handlers,
// promises) — at minimum they land in the devtools console with context.
window.addEventListener("unhandledrejection", (event) => {
	console.error("[renderer] unhandled rejection:", event.reason);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<AppErrorBoundary>
			<ThemeProvider>
				<I18nProvider>
					<App />
				</I18nProvider>
			</ThemeProvider>
		</AppErrorBoundary>
	</React.StrictMode>,
);
