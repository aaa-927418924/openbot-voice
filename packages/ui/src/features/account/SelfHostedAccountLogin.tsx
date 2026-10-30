import { AppLogo } from "@openbot/brand";
import type {
  AppVariant,
  CentralAuthState,
  SelfHostedAccountLoginInput,
  SelfHostedAccountRegistrationInput,
} from "@openbot/contracts/ipc";
import { Button, Input } from "@openbot/ui";
import { createSignal, onSettled, Show } from "solid-js";
import { useText } from "../../text";

type FormMode = "sign_in" | "register";
type PendingAction = "retry" | "submit" | "local" | null;

interface SelfHostedAccountLoginProps {
  variant: AppVariant;
  state: CentralAuthState;
  onRetry: () => Promise<void>;
  onSignIn: (input: SelfHostedAccountLoginInput) => Promise<void>;
  onRegister: (input: SelfHostedAccountRegistrationInput) => Promise<void>;
  onUseLocalProfile: () => Promise<void>;
  getServerAddress: () => Promise<string>;
}

export function SelfHostedAccountLogin(props: SelfHostedAccountLoginProps) {
  const { t } = useText();
  const [mode, setMode] = createSignal<FormMode>("sign_in");
  const [serverAddress, setServerAddress] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<PendingAction>(null);

  onSettled(() => {
    void props
      .getServerAddress()
      .then(setServerAddress)
      .catch(() => undefined);
  });

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (pending()) return;
    setError(null);
    setPending("submit");
    try {
      const credentials = { serverAddress: serverAddress().trim(), email: email().trim(), password: password() };
      if (mode() === "register") await props.onRegister({ ...credentials, name: name().trim() });
      else await props.onSignIn(credentials);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("account.selfHosted.failed"));
    } finally {
      setPending(null);
      setPassword("");
    }
  }

  async function retry(): Promise<void> {
    if (pending()) return;
    setError(null);
    setPending("retry");
    try {
      await props.onRetry();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("account.selfHosted.failed"));
    } finally {
      setPending(null);
    }
  }

  async function useLocal(): Promise<void> {
    if (pending()) return;
    setPending("local");
    setError(null);
    try {
      await props.onUseLocalProfile();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("account.selfHosted.failed"));
    } finally {
      setPending(null);
    }
  }

  return (
    <main class="account-login-screen">
      <div class="account-login-shell">
        <header class="account-login-brand-lockup">
          <AppLogo variant={props.variant} animation="blink" interactive class="account-login-logo" />
          <span class="account-login-wordmark">{t("account.selfHosted.productName")}</span>
        </header>
        <section class="account-login" aria-labelledby="self-hosted-account-title">
          <h1 id="self-hosted-account-title" class="account-login-title">
            {t("account.selfHosted.title")}
          </h1>
          <p class="account-login-description">{t("account.selfHosted.description")}</p>
          <Show when={props.state.status === "loading"}>
            <div class="account-login-loader" role="status" aria-live="polite">
              <span class="account-login-spinner" aria-hidden="true" />
              <span>{t("account.login.connectingSecurely")}</span>
            </div>
          </Show>
          <form
            class="account-login-form"
            aria-busy={pending() !== null ? "true" : "false"}
            onSubmit={(event) => void submit(event)}
          >
            <label class="sr-only" for="self-hosted-server-address">
              {t("account.selfHosted.serverAddress")}
            </label>
            <Input
              id="self-hosted-server-address"
              class="t-input"
              type="url"
              autocomplete="url"
              inputmode="url"
              placeholder={t("account.selfHosted.serverAddressPlaceholder")}
              maxlength={2048}
              value={serverAddress()}
              required
              onInput={(event) => setServerAddress(event.currentTarget.value)}
            />
            <Show when={mode() === "register"}>
              <label class="sr-only" for="self-hosted-account-name">
                {t("account.selfHosted.name")}
              </label>
              <Input
                id="self-hosted-account-name"
                class="t-input"
                type="text"
                autocomplete="name"
                placeholder={t("account.selfHosted.name")}
                maxlength={20}
                value={name()}
                required
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </Show>
            <label class="sr-only" for="self-hosted-account-email">
              {t("account.login.email")}
            </label>
            <Input
              id="self-hosted-account-email"
              class="t-input"
              type="email"
              autocomplete="email"
              inputmode="email"
              autocapitalize="none"
              spellcheck={false}
              placeholder={t("account.login.email")}
              maxlength={254}
              value={email()}
              required
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
            <label class="sr-only" for="self-hosted-account-password">
              {t("account.selfHosted.password")}
            </label>
            <Input
              id="self-hosted-account-password"
              class="t-input"
              type="password"
              autocomplete={mode() === "register" ? "new-password" : "current-password"}
              placeholder={
                mode() === "register" ? t("account.selfHosted.passwordHint") : t("account.selfHosted.password")
              }
              maxlength={256}
              value={password()}
              required
              onInput={(event) => setPassword(event.currentTarget.value)}
            />
            <Show when={props.state.status === "error" ? props.state.issue.message : null}>
              {(message) => (
                <p class="account-login-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={error()}>
              {(message) => (
                <p class="account-login-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Button
              variant="default"
              type="submit"
              class="account-login-primary"
              disabled={pending() !== null || props.state.status === "loading"}
            >
              <Show
                when={pending() === "submit"}
                fallback={mode() === "register" ? t("account.selfHosted.create") : t("account.selfHosted.signIn")}
              >
                <span class="account-login-button-spinner" aria-hidden="true" />
                {t("account.selfHosted.working")}
              </Show>
            </Button>
          </form>
          <div class="account-login-code-actions">
            <Button
              variant="ghost"
              type="button"
              class="account-login-code-action account-login-code-action-change"
              disabled={pending() !== null}
              onClick={() => {
                setError(null);
                setMode(mode() === "sign_in" ? "register" : "sign_in");
              }}
            >
              {mode() === "sign_in" ? t("account.selfHosted.switchToRegister") : t("account.selfHosted.switchToSignIn")}
            </Button>
          </div>
          <Show when={props.state.status === "error" || props.state.status === "signed_out"}>
            <Button
              variant="default"
              type="button"
              class="account-login-primary"
              disabled={pending() !== null}
              onClick={() => void retry()}
            >
              <Show when={pending() === "retry"} fallback={t("common.tryAgain")}>
                <span class="account-login-button-spinner" aria-hidden="true" />
                {t("common.connecting")}
              </Show>
            </Button>
          </Show>
          <Button
            variant="ghost"
            type="button"
            class="account-login-code-action"
            disabled={pending() !== null}
            onClick={() => void useLocal()}
          >
            <Show when={pending() === "local"} fallback={t("account.selfHosted.useLocalProfile")}>
              <span class="account-login-button-spinner" aria-hidden="true" />
              {t("account.selfHosted.working")}
            </Show>
          </Button>
        </section>
      </div>
    </main>
  );
}
