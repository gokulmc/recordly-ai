import React from "react";

interface Props {
	children: React.ReactNode;
}

interface State {
	error: Error | null;
	componentStack: string | null;
}

/**
 * Top-level error boundary. Without one, any render exception unmounts the
 * whole React tree and the window goes blank (white on light windows) with
 * zero indication of what happened. This shows the actual error instead so
 * crashes are reportable.
 */
export class AppErrorBoundary extends React.Component<Props, State> {
	state: State = { error: null, componentStack: null };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo) {
		console.error("[AppErrorBoundary] render crash:", error, info.componentStack);
		this.setState({ componentStack: info.componentStack ?? null });
	}

	render() {
		if (!this.state.error) return this.props.children;

		return (
			<div
				style={{
					height: "100vh",
					background: "#0f0f10",
					color: "#e4e4e7",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					gap: 12,
					padding: 24,
					fontFamily: "SF Pro Display, Roboto, Helvetica, sans-serif",
					userSelect: "text",
					WebkitUserSelect: "text",
				}}
			>
				<div style={{ fontSize: 15, fontWeight: 600, color: "#f87171" }}>
					Something crashed in this window
				</div>
				<pre
					style={{
						maxWidth: "100%",
						maxHeight: "50vh",
						overflow: "auto",
						fontSize: 11,
						lineHeight: 1.5,
						color: "rgba(255,255,255,0.7)",
						background: "rgba(255,255,255,0.06)",
						borderRadius: 8,
						padding: "10px 14px",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						margin: 0,
					}}
				>
					{String(this.state.error?.stack || this.state.error?.message || this.state.error)}
					{this.state.componentStack ? `\n\nComponent stack:${this.state.componentStack}` : ""}
				</pre>
				<button
					type="button"
					onClick={() => window.location.reload()}
					style={{
						height: 34,
						padding: "0 16px",
						borderRadius: 8,
						border: "1px solid rgba(255,255,255,0.15)",
						background: "rgba(255,255,255,0.08)",
						color: "#e4e4e7",
						fontSize: 13,
						fontWeight: 500,
						cursor: "pointer",
					}}
				>
					Reload window
				</button>
			</div>
		);
	}
}
