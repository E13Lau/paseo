import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ConversationHistoryScreen } from "@/screens/conversation-history-screen";

export default function HostHistoryRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ConversationHistoryScreen />
    </HostRouteBootstrapBoundary>
  );
}
