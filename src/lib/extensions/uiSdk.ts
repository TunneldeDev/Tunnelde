import * as React from "react";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Field, Input, Textarea, Switch } from "@/components/ui/form/Field";
import { SearchField } from "@/components/ui/form/SearchField";
import { EmptyState } from "@/components/ui/display/Misc";
import type { UiSdk } from "./uiSdkContract";
export type { FrontendContext, FrontendViewProps, FrontendModule } from "./uiSdkContract";

/** Experimental, versioned surface. Plugins receive this object at activation;
 * React and host components must not be bundled into the plugin a second time.
 */
export const uiSdk: UiSdk = Object.freeze({
  version: "0.1.0" as const,
  react: React,
  components: Object.freeze({
    Button,
    IconButton,
    Field,
    Input,
    Textarea,
    Switch,
    SearchField,
    EmptyState,
  }),
});
