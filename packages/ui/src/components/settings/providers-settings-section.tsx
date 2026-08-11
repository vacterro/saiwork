import { type Component } from "solid-js"
import { activeInstanceId } from "../../stores/instances"
import { GoogleProvidersCard } from "./google-providers-card"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"

export const ProvidersSettingsSection: Component = () => {
  return (
    <div class="settings-section-stack">
      <GoogleProvidersCard />
      <ProviderManagerModal instanceId={activeInstanceId() ?? ""} embedded />
    </div>
  )
}
