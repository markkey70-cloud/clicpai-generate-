import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clapperboard,
  Download,
  Film,
  History,
  Layers3,
  ImagePlus,
  LoaderCircle,
  Menu,
  Mic2,
  MessageSquareText,
  Play,
  Plus,
  LogOut,
  Sparkles,
  Ticket,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import {
  getGetBillingPlansQueryKey,
  getGetPredictionQueryKey,
  useGetBillingPlans,
  getListPredictionsQueryKey,
  getListVideoModelsQueryKey,
  useCreateBillingCheckout,
  useCreatePrediction,
  useGetPrediction,
  useListPredictions,
  useListVideoModels,
} from '@workspace/api-client-react';
import type { Prediction, PredictionInput, VideoModel } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { AddSoundButton } from '@/components/AddSoundButton';
import { ContinueVideoButton } from '@/components/ContinueVideoButton';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const contactEmail = 'markkey70@clicpai.com';
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#182033',
    colorForeground: '#182033',
    colorMutedForeground: '#68707d',
    colorDanger: '#c33d4d',
    colorBackground: '#f7f4ee',
    colorInput: '#ffffff',
    colorInputForeground: '#182033',
    colorNeutral: '#d9d5cc',
    fontFamily: '"Manrope", sans-serif',
    borderRadius: '0.8rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#f7f4ee] rounded-3xl w-[440px] max-w-full overflow-hidden border border-black/10 shadow-2xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'font-display text-[#182033]',
    headerSubtitle: 'text-[#68707d]',
    socialButtonsBlockButtonText: 'text-[#182033] font-semibold',
    formFieldLabel: 'text-[#182033] font-semibold',
    footerActionLink: 'text-[#182033] font-bold',
    footerActionText: 'text-[#68707d]',
    dividerText: 'text-[#68707d]',
    identityPreviewEditButton: 'text-[#182033]',
    formFieldSuccessText: 'text-[#3d8f7d]',
    alertText: 'text-[#9f2f40]',
    logoBox: 'h-12',
    logoImage: 'h-12',
    socialButtonsBlockButton: 'border-black/15 bg-white hover:bg-[#ebe7df]',
    formButtonPrimary: 'bg-[#182033] text-white hover:bg-[#2a344d]',
    formFieldInput: 'border-black/15 bg-white text-[#182033]',
    footerAction: 'bg-transparent',
    dividerLine: 'bg-black/10',
    alert: 'bg-red-50 border-red-200',
    otpCodeFieldInput: 'border-black/15 bg-white text-[#182033]',
    formFieldRow: 'text-[#182033]',
    main: 'gap-5',
  },
};

const aspectOptions: PredictionInput['aspectRatio'][] = ['16:9', '9:16', '1:1'];
const voiceStyleOptions = [
  { value: 'male', label: "Man's voice", detail: 'Natural adult tone' },
  { value: 'female', label: "Woman's voice", detail: 'Natural adult tone' },
  { value: 'child', label: 'Kid-style voice', detail: 'Bright and youthful' },
] as const;

function mediaUrl(value: string | null, _kind: 'video' | 'thumbnail') {
  return value || undefined;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Just now';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatStatus(status?: Prediction['status']) {
  if (!status) return 'Waiting';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { user } = useUser();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [creditsRemaining, setCreditsRemaining] = useState<number | null>(null);
  const isPricing = location === '/pricing';
  const navItems = [
    { href: '/studio', label: 'Create', icon: Sparkles },
    { href: '/history', label: 'History', icon: History },
    { href: '/pricing', label: 'Credits', icon: Ticket },
  ];
  useEffect(() => {
    let active = true;
    const loadCredits = () => {
      fetch('/api/billing/account', { credentials: 'include' })
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not load credits.');
          return (await response.json()) as { creditsRemaining: number };
        })
        .then((account) => { if (active) setCreditsRemaining(account.creditsRemaining); })
        .catch(() => { if (active) setCreditsRemaining(null); });
    };
    loadCredits();
    const pollCredits = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadCredits();
    }, 60_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadCredits();
    };
    window.addEventListener('credits:updated', loadCredits);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(pollCredits);
      window.removeEventListener('credits:updated', loadCredits);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [user?.id]);
  const creditsProgress = Math.min(100, Math.max(0, ((creditsRemaining ?? 0) / 240) * 100));
  return (
    <div className="app-noise min-h-[100dvh] bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-[252px] flex-col justify-between border-r border-sidebar-border bg-sidebar px-5 py-6 text-sidebar-foreground md:flex">
        <div>
          <Brand />
          <div className="mt-12">
             <p className="mb-3 px-3 font-mono-ui text-xs font-semibold uppercase tracking-[.18em] text-sidebar-foreground/55">Studio</p>
            <nav className="space-y-1" aria-label="Main navigation">
              {navItems.map((item) => (
                <NavItem key={item.href} {...item} active={location === item.href} />
              ))}
            </nav>
          </div>
          <div className="mt-10 rounded-2xl border border-sidebar-border bg-sidebar-accent/70 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-sidebar-foreground/45">Balance</span>
              <Zap size={14} className="text-sidebar-primary" />
            </div>
             <p className="font-display text-2xl font-semibold text-sidebar-foreground">{creditsRemaining ?? '—'} <span className="font-sans text-xs font-medium text-sidebar-foreground/45">credits</span></p>
             <div className="mt-3 h-1 overflow-hidden rounded-full bg-sidebar-foreground/10"><div className="h-full rounded-full bg-sidebar-primary transition-all" style={{ width: `${creditsProgress}%` }} /></div>
            <Link href="/pricing" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-sidebar-primary transition hover:text-sidebar-foreground" data-testid="link-buy-credits">Get more credits <ArrowUpRight size={12} /></Link>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-sidebar-border pt-5">
           <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-primary font-display text-sm font-bold text-sidebar-primary-foreground">{user?.firstName?.slice(0, 1).toUpperCase() || user?.primaryEmailAddress?.emailAddress.slice(0, 1).toUpperCase() || 'C'}</div>
           <div className="min-w-0"><p className="truncate text-xs font-bold">{user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Creator'}</p><p className="font-mono-ui text-[10px] text-sidebar-foreground/45">Creative workspace</p></div>
           <button type="button" onClick={() => signOut({ redirectUrl: basePath || '/' })} className="ml-auto rounded-lg p-2 text-sidebar-foreground/40 transition hover:bg-sidebar-accent hover:text-sidebar-foreground" aria-label="Sign out" data-testid="button-sign-out"><LogOut size={15} /></button>
        </div>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm md:hidden" onClick={() => setMobileOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-[270px] flex-col justify-between bg-sidebar px-5 py-6 text-sidebar-foreground transition-transform md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
         <div>
           <Brand />
           <div className="mt-12 space-y-1">{navItems.map((item) => <NavItem key={item.href} {...item} active={location === item.href} onClick={() => setMobileOpen(false)} />)}</div>
           <SiteNavLinks className="mt-6 flex flex-col gap-1 border-t border-sidebar-border pt-5 text-sm font-semibold text-sidebar-foreground/70" />
         </div>
        <div className="border-t border-sidebar-border pt-5"><p className="truncate text-xs font-bold">{user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Creator'}</p><button type="button" onClick={() => signOut({ redirectUrl: basePath || '/' })} className="mt-3 flex items-center gap-2 text-xs text-sidebar-foreground/60"><LogOut size={14} /> Sign out</button></div>
      </aside>
      <main className="min-h-[100dvh] md:pl-[252px]">
        <header className={`sticky top-0 z-30 flex h-[76px] items-center justify-between border-b px-5 backdrop-blur-xl md:px-10 ${isPricing ? 'border-white/10 bg-[#080b18]/90 text-white' : 'border-border/80 bg-background/85'}`}>
          <button className="rounded-lg p-2 md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu" data-testid="button-open-menu"><Menu size={20} /></button>
           <div className="hidden md:block"><p className={`font-display text-lg font-bold tracking-[.06em] ${isPricing ? 'text-white/75' : 'text-foreground/85'}`}>clicpai.com <span className="mx-2 text-accent">/</span> {isPricing ? 'Pricing' : 'Studio'}</p></div>
            <SiteNavLinks className={`ml-auto flex shrink-0 items-center gap-2 text-[10px] font-semibold sm:gap-3 sm:text-xs ${isPricing ? 'text-white/75' : 'text-muted-foreground'}`} />
            <div className="ml-3 flex shrink-0 items-center gap-2 sm:gap-3"><span className={`rounded-full border px-2 py-1.5 font-mono-ui text-[9px] font-semibold uppercase tracking-[.08em] sm:px-3 sm:text-[10px] sm:tracking-[.12em] ${isPricing ? 'border-white/15 bg-white/10 text-white/80' : 'border-border bg-card text-foreground'}`} data-testid="badge-remaining-credits"><span className="sm:hidden">Credits:</span><span className="hidden sm:inline">Remaining Credits:</span> {creditsRemaining ?? '—'}</span><span className={`hidden font-mono-ui text-[10px] uppercase tracking-[.15em] sm:inline ${isPricing ? 'text-white/45' : 'text-muted-foreground'}`}>Replicate live</span><div className="h-2 w-2 rounded-full bg-[#5db9a5] shadow-[0_0_0_4px_hsl(165_41%_55%/15%)]" /></div>
        </header>
        {children}
      </main>
    </div>
  );
}

function Brand() {
  return <Link href="/studio" className="flex items-center gap-3" data-testid="link-brand"><span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground"><Clapperboard size={20} strokeWidth={2.4} /><span className="absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full bg-sidebar" /></span><span className="font-display text-2xl font-bold tracking-tight">clicpai<span className="text-sidebar-primary">.com</span></span></Link>;
}

function SiteNavLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="About and contact" className={className}>
      <Link href="/about" className="whitespace-nowrap transition hover:opacity-75">About Us</Link>
      <a href={`mailto:${contactEmail}`} className="whitespace-nowrap transition hover:opacity-75">Contact Us</a>
    </nav>
  );
}

function PublicHeader() {
  return (
    <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-3">
      <Link href="/" className="flex min-w-0 items-center gap-2 sm:gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground text-background"><Clapperboard size={20} /></span>
        <span className="truncate font-display text-lg font-bold sm:text-2xl">clicpai<span className="text-muted-foreground">.com</span></span>
      </Link>
      <SiteNavLinks className="order-3 flex w-full items-center justify-center gap-6 border-t border-border/70 pt-3 text-xs font-bold text-muted-foreground sm:order-none sm:w-auto sm:border-0 sm:pt-0 sm:text-sm" />
      <div className="order-2 flex shrink-0 items-center gap-1 sm:order-none sm:gap-2">
        <Link href="/sign-in" className="whitespace-nowrap rounded-xl px-2 py-2.5 text-xs font-bold text-muted-foreground transition hover:text-foreground sm:px-4 sm:text-sm">Sign in</Link>
        <Link href="/sign-up" className="whitespace-nowrap rounded-xl bg-foreground px-3 py-2.5 text-xs font-bold text-background transition hover:opacity-85 sm:px-4 sm:text-sm"><span className="sm:hidden">Sign up</span><span className="hidden sm:inline">Create account</span></Link>
      </div>
    </header>
  );
}

function getModelCreditCost(model: VideoModel | undefined, duration: number) {
  return model?.creditCosts[String(duration)] ?? null;
}

function NavItem({ href, label, icon: Icon, active, onClick }: { href: string; label: string; icon: typeof Sparkles; active: boolean; onClick?: () => void }) {
  return <Link href={href} onClick={onClick} className={`group flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition ${active ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'text-sidebar-foreground/62 hover:bg-sidebar-accent hover:text-sidebar-foreground'}`} data-testid={`link-nav-${label.toLowerCase()}`}><Icon size={17} strokeWidth={active ? 2.4 : 1.8} /><span>{label}</span>{active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary-foreground" />}</Link>;
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description: string; action?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-muted-foreground">{eyebrow}</p><h1 className="mt-3 max-w-3xl font-display text-4xl font-semibold leading-[.98] tracking-[-.04em] text-foreground sm:text-5xl">{title}</h1><p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p></div>{action}</div>;
}

function ModelCard({ model, selected, onSelect }: { model: VideoModel; selected: boolean; onSelect: () => void }) {
  const startingCost = Math.min(...Object.values(model.creditCosts));
  return <button type="button" onClick={onSelect} className={`group relative overflow-hidden rounded-2xl border text-left transition duration-300 ${selected ? 'border-foreground bg-foreground text-background shadow-[6px_6px_0_hsl(var(--accent))]' : 'border-border bg-card hover:-translate-y-0.5 hover:border-foreground/40'}`} data-testid={`button-model-${model.id}`}>
    <div className="relative h-28 overflow-hidden bg-secondary"><img src={model.image} alt="" className="h-full w-full object-cover opacity-90 transition duration-500 group-hover:scale-105" onError={(event) => { event.currentTarget.style.display = 'none'; }} /><div className="absolute inset-0 bg-gradient-to-t from-foreground/55 to-transparent" /><span className="absolute bottom-3 left-3 rounded-full bg-background/80 px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[.15em] text-foreground backdrop-blur">{model.provider}</span>{selected && <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-foreground"><Check size={14} strokeWidth={3} /></span>}</div>
    <div className="p-4"><div className="flex items-start justify-between gap-2"><span className={`font-display text-lg font-semibold ${selected ? 'text-background' : 'text-foreground'}`}>{model.name}</span><span className={`font-mono-ui text-[10px] ${selected ? 'text-background/60' : 'text-muted-foreground'}`}>{model.duration}</span></div><p className={`mt-2 line-clamp-2 text-xs leading-5 ${selected ? 'text-background/65' : 'text-muted-foreground'}`}>{model.description}</p><div className="mt-4 flex items-center justify-between"><span className={`font-mono-ui text-xs ${selected ? 'text-accent' : 'text-foreground'}`}>from {startingCost} credits / video</span><span className={`text-[10px] font-bold uppercase tracking-[.15em] ${selected ? 'text-background/50' : 'text-muted-foreground'}`}>Select</span></div></div>
  </button>;
}

function PromptComposer({ models, onCreated, activePredictionId, activePrediction, selectedModelId, onModelChange }: { models: VideoModel[]; onCreated: (prediction: Prediction) => void; activePredictionId: string | null; activePrediction?: Prediction; selectedModelId: string; onModelChange: (modelId: string) => void }) {
  const createPrediction = useCreatePrediction();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<PredictionInput['aspectRatio']>('16:9');
  const [duration, setDuration] = useState<PredictionInput['duration']>(5);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [imagePurpose, setImagePurpose] = useState<'product' | 'avatar'>('product');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<'photo' | 'recording'>('photo');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<'none' | 'text' | 'upload'>('none');
  const [lipSyncEnabled, setLipSyncEnabled] = useState(false);
  const [voiceStyle, setVoiceStyle] = useState<PredictionInput['voiceStyle']>('male');
  const [voiceText, setVoiceText] = useState('');
  const [voiceFile, setVoiceFile] = useState<File | null>(null);

  const selectedModel = models.find((model) => model.id === selectedModelId);
  const isHailuo = selectedModel?.id === 'minimax/hailuo-2.3';
  const durationOptions: PredictionInput['duration'][] = isHailuo ? [6, 10] : [5, 10];
  const availableAspectOptions: PredictionInput['aspectRatio'][] = isHailuo
    ? ['16:9']
    : ['16:9', '9:16', '1:1'];
  const creditCost = getModelCreditCost(selectedModel, duration);
  const lipSyncTotalCreditCost = selectedModel?.lipSyncCreditCosts[String(duration)];
  const lipSyncEligible = !!referenceFile && imagePurpose === 'avatar' && voiceMode !== 'none';
  const totalCreditCost = creditCost == null
    ? null
    : lipSyncEligible && lipSyncEnabled
      ? lipSyncTotalCreditCost ?? null
      : creditCost;
  const isWorking = createPrediction.isPending || (!!activePredictionId && !!activePrediction && !['succeeded', 'failed', 'canceled'].includes(activePrediction.status));
  useEffect(() => {
    if (!lipSyncEligible) setLipSyncEnabled(false);
  }, [lipSyncEligible]);
  useEffect(() => {
    setDuration(selectedModelId === 'minimax/hailuo-2.3' ? 6 : 5);
    setAspectRatio('16:9');
  }, [selectedModelId]);
  useEffect(() => {
    if (!referenceFile) {
      setReferencePreview(null);
      return;
    }
    const preview = URL.createObjectURL(referenceFile);
    setReferencePreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [referenceFile]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 3 || !selectedModelId || createPrediction.isPending || isUploading) return;
    setUploadError(null);
    if (voiceMode === 'text' && !voiceText.trim()) {
      setUploadError('Enter a script for the AI voice, or choose another voice option.');
      return;
    }
    if (voiceMode === 'upload' && (!voiceFile || voiceFile.size === 0 || voiceFile.size > 20 * 1024 * 1024)) {
      setUploadError('Choose an audio recording up to 20 MB.');
      return;
    }
    let imageUploadId: string | null = null;
    let voiceUploadId: string | null = null;
    if (referenceFile) {
      try {
        setUploadStage('photo');
        setIsUploading(true);
        const request = await fetch('/api/uploads/images', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: referenceFile.type, size: referenceFile.size }),
        });
        const details = await request.json() as { uploadId?: string; uploadUrl?: string; error?: string };
        if (!request.ok || !details.uploadId || !details.uploadUrl) throw new Error(details.error || 'Could not prepare image upload.');
        const upload = await fetch(details.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': referenceFile.type },
          body: referenceFile,
        });
        if (!upload.ok) throw new Error('Could not upload the reference image.');
        imageUploadId = details.uploadId;
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : 'Could not upload the reference image.');
        setIsUploading(false);
        return;
      }
    }
    if (voiceMode === 'upload' && voiceFile) {
      try {
        setUploadStage('recording');
        setIsUploading(true);
        const request = await fetch('/api/uploads/voices', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: voiceFile.type, size: voiceFile.size }),
        });
        const details = await request.json() as { uploadId?: string; uploadUrl?: string; error?: string };
        if (!request.ok || !details.uploadId || !details.uploadUrl) throw new Error(details.error || 'Could not prepare the voice recording upload.');
        const upload = await fetch(details.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': voiceFile.type },
          body: voiceFile,
        });
        if (!upload.ok) throw new Error('Could not upload the voice recording.');
        voiceUploadId = details.uploadId;
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : 'Could not upload the voice recording.');
        setIsUploading(false);
        return;
      }
    }
    setIsUploading(false);
    createPrediction.mutate({ data: { prompt: prompt.trim(), modelId: selectedModelId, aspectRatio, duration, expectedCreditCost: totalCreditCost ?? undefined, negativePrompt: negativePrompt.trim() || null, imageUploadId, imagePurpose: imageUploadId ? imagePurpose : null, lipSyncEnabled: lipSyncEligible && lipSyncEnabled, voiceMode, voiceStyle: voiceMode === 'text' ? voiceStyle : 'male', voiceText: voiceMode === 'text' ? voiceText.trim() : null, voiceUploadId } }, {
      onSuccess: (prediction) => {
        queryClient.invalidateQueries({ queryKey: getListPredictionsQueryKey() });
        window.dispatchEvent(new Event('credits:updated'));
        onCreated(prediction);
        setPrompt('');
        setNegativePrompt('');
        setReferenceFile(null);
        setVoiceText('');
        setVoiceFile(null);
        setVoiceMode('none');
        setLipSyncEnabled(false);
        setVoiceStyle('male');
      },
    });
  };
  return <form id="create" onSubmit={submit} className="relative overflow-hidden rounded-[26px] border border-border bg-card p-5 shadow-[0_20px_60px_hsl(221_27%_15%/5%)] sm:p-7" data-testid="form-create-video">
    <div className="absolute right-0 top-0 h-36 w-36 translate-x-1/3 -translate-y-1/3 rounded-full bg-accent/20 blur-3xl" />
       <div className="relative">
      <div className="flex items-center justify-between"><div className="flex items-center gap-2"><MessageSquareText size={16} className="text-accent-foreground" /><span className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-muted-foreground">The brief</span></div><span className="font-mono-ui text-[10px] text-muted-foreground">{prompt.length}/600</span></div>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value.slice(0, 600))} rows={5} placeholder="A lone cyclist cuts through the neon rain of a sleeping city…" className="mt-5 w-full resize-none bg-transparent font-display text-2xl font-medium leading-[1.2] tracking-[-.03em] text-foreground outline-none placeholder:text-muted-foreground/45 sm:text-[27px]" data-testid="input-prompt" />
      <div className="mt-5 flex flex-wrap gap-2"><PromptChip text="Cinematic" onClick={() => setPrompt((current) => `${current}${current ? ', ' : ''}cinematic lighting, 35mm texture`)} /><PromptChip text="Product launch" onClick={() => setPrompt((current) => `${current}${current ? ', ' : ''}hero product reveal, polished commercial`)} /><PromptChip text="Social hook" onClick={() => setPrompt((current) => `${current}${current ? ', ' : ''}fast opening hook, high energy edit`)} /></div>
      <div className="mt-5 rounded-2xl border border-dashed border-border bg-background/60 p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {referencePreview ? <img src={referencePreview} alt="Reference preview" className="h-24 w-24 rounded-xl object-cover" /> : <div className="grid h-24 w-24 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><ImagePlus size={24} /></div>}
          <div className="flex-1">
            <p className="text-sm font-bold">Add a product or avatar photo</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">The engine will animate this image while keeping the subject recognizable. JPEG, PNG, or WebP up to 10 MB.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="cursor-pointer rounded-lg bg-foreground px-3 py-2 text-xs font-bold text-background transition hover:opacity-85">
                {referenceFile ? 'Change photo' : 'Upload photo'}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => setReferenceFile(event.target.files?.[0] ?? null)} data-testid="input-reference-image" />
              </label>
              {referenceFile && <button type="button" onClick={() => setReferenceFile(null)} className="rounded-lg border border-border px-3 py-2 text-xs font-bold text-muted-foreground">Remove</button>}
              <div className="flex rounded-lg border border-border p-1">
                {(['product', 'avatar'] as const).map((purpose) => <button key={purpose} type="button" onClick={() => setImagePurpose(purpose)} className={`rounded-md px-3 py-1.5 text-xs font-bold capitalize ${imagePurpose === purpose ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}>{purpose}</button>)}
              </div>
            </div>
          </div>
        </div>
      </div>
       <div className="my-6 h-px bg-border" />
       <section className="rounded-2xl border border-border bg-background/60 p-4 sm:p-5" aria-labelledby="voice-options-title">
         <div className="flex items-start gap-3">
           <Mic2 size={17} className="mt-0.5 shrink-0 text-accent-foreground" />
           <div><p id="voice-options-title" className="text-sm font-bold">Voice for your video</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Choose narration before you generate. You can also make this video without a voice.</p></div>
         </div>
         <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Voice option">
           {([{ value: 'none', label: 'No voice' }, { value: 'text', label: 'AI voice from script' }, { value: 'upload', label: 'Upload my recording' }] as const).map((option) => <button key={option.value} type="button" role="radio" aria-checked={voiceMode === option.value} onClick={() => { setVoiceMode(option.value); setUploadError(option.value === 'upload' && voiceFile && (voiceFile.size === 0 || voiceFile.size > 20 * 1024 * 1024) ? 'Choose an audio recording up to 20 MB.' : null); }} className={`rounded-xl border px-3 py-3 text-left text-xs font-bold transition ${voiceMode === option.value ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:border-foreground/40 hover:text-foreground'}`} data-testid={`button-voice-mode-${option.value}`}>{option.label}</button>)}
         </div>
          {lipSyncEligible && <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-accent/40 bg-accent/5 p-3">
            <input type="checkbox" checked={lipSyncEnabled} onChange={(event) => setLipSyncEnabled(event.target.checked)} className="mt-0.5 accent-[hsl(var(--accent))]" data-testid="checkbox-lipsync" />
            <span><span className="block text-xs font-bold">Lip-sync avatar to narration · {lipSyncTotalCreditCost ?? '—'} credits total</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">Sends this video and narration to Kling through Replicate. Use a face you have permission to animate.</span></span>
          </label>}
         {voiceMode === 'text' && <div className="mt-4">
           <fieldset>
             <legend className="text-xs font-bold">AI voice style</legend>
             <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="AI voice style">
               {voiceStyleOptions.map((option) => <button key={option.value} type="button" role="radio" aria-checked={voiceStyle === option.value} onClick={() => setVoiceStyle(option.value)} className={`rounded-xl border px-3 py-3 text-left transition ${voiceStyle === option.value ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:border-foreground/40 hover:text-foreground'}`} data-testid={`button-voice-style-${option.value}`}><span className="block text-xs font-bold">{option.label}</span><span className={`mt-1 block text-[10px] ${voiceStyle === option.value ? 'text-background/70' : 'text-muted-foreground'}`}>{option.detail}</span></button>)}
             </div>
             {voiceStyle === 'child' && <p className="mt-2 text-[11px] leading-4 text-muted-foreground">This is a fictional AI voice, not a recording or imitation of a real child.</p>}
           </fieldset>
           <div className="mt-4">
           <div className="flex items-center justify-between gap-3"><label htmlFor="voice-script" className="text-xs font-bold">Narration script</label><span className="font-mono-ui text-[10px] text-muted-foreground">{voiceText.length}/1200</span></div>
           <textarea id="voice-script" value={voiceText} onChange={(event) => setVoiceText(event.target.value.slice(0, 1200))} maxLength={1200} rows={3} placeholder="Type the words you want the AI voice to say…" className="mt-2 w-full resize-y rounded-xl border border-input bg-card px-3 py-3 text-sm outline-none transition focus:border-foreground" data-testid="input-voice-script" />
            <p className="mt-2 text-xs text-muted-foreground">Audio longer than your video is trimmed to fit.</p>
           </div>
         </div>}
         {voiceMode === 'upload' && <div className="mt-4">
           <label htmlFor="voice-recording" className="block text-xs font-bold">Your audio recording</label>
           <label className="mt-2 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-4 text-sm font-semibold transition hover:border-foreground/50">
             <Upload size={18} className="shrink-0 text-muted-foreground" />
             <span className="min-w-0 flex-1 truncate">{voiceFile ? voiceFile.name : 'Choose an audio file'}</span>
             <input id="voice-recording" type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" className="sr-only" onChange={(event) => { const file = event.target.files?.[0] ?? null; setVoiceFile(file); setUploadError(file && (file.size === 0 || file.size > 20 * 1024 * 1024) ? 'Choose an audio recording up to 20 MB.' : null); }} data-testid="input-voice-recording" />
           </label>
            <p className="mt-2 text-xs text-muted-foreground">Audio files up to 20 MB. Use a recording you own or have permission to use. Audio longer than your video is trimmed to fit.</p>
           {voiceFile && <button type="button" onClick={() => { setVoiceFile(null); setUploadError(null); }} className="mt-2 text-xs font-bold text-muted-foreground underline underline-offset-2 hover:text-foreground">Remove recording</button>}
         </div>}
       </section>
       {uploadError && <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive" data-testid="text-voice-upload-error">{uploadError}</p>}
       <div className="my-6 h-px bg-border" />
          <div className="grid gap-5 sm:grid-cols-[1.3fr_1fr_1fr]"><div><label className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground" htmlFor="model">Engine</label><select id="model" value={selectedModelId} onChange={(event) => onModelChange(event.target.value)} disabled={models.length <= 1} className="w-full appearance-none rounded-xl border border-input bg-background px-3 py-3 text-sm font-bold outline-none transition focus:border-foreground disabled:cursor-not-allowed disabled:opacity-100" data-testid="select-model">{models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>) : <option value="">No engines available</option>}</select></div><div><span className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">Frame</span><div className={`grid gap-1 rounded-xl border border-input bg-background p-1 ${availableAspectOptions.length === 1 ? 'grid-cols-1' : 'grid-cols-3'}`}>{availableAspectOptions.map((ratio) => <button type="button" key={ratio} onClick={() => setAspectRatio(ratio)} className={`rounded-lg py-2 text-xs font-bold transition ${aspectRatio === ratio ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`} data-testid={`button-aspect-${ratio.replace(':', '-')}`}>{ratio}</button>)}</div></div><div><span className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">Length</span><div className={`grid gap-1 rounded-xl border border-input bg-background p-1 ${durationOptions.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>{durationOptions.map((seconds) => <button type="button" key={seconds} onClick={() => setDuration(seconds)} className={`rounded-lg py-2 text-xs font-bold transition ${duration === seconds ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`} data-testid={`button-duration-${seconds}`}>{seconds}s</button>)}</div></div></div>
      <button type="button" onClick={() => setShowAdvanced((current) => !current)} className="mt-5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground transition hover:text-foreground" data-testid="button-toggle-advanced"><ChevronDown size={14} className={`transition ${showAdvanced ? 'rotate-180' : ''}`} /> Advanced direction</button>
      {showAdvanced && <div className="mt-3 rounded-xl border border-border bg-background p-3"><label className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground" htmlFor="negative">Avoid in the frame</label><input id="negative" value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="text, logos, shaky camera…" className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50" data-testid="input-negative-prompt" /></div>}
       {createPrediction.isError && <p className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive" data-testid="status-create-error">{createPrediction.error.message || 'Could not start this generation.'}</p>}
          <div className="mt-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center"><div className="flex items-center gap-2 text-xs text-muted-foreground"><div className="h-2 w-2 rounded-full bg-[#5db9a5]" />{selectedModel && totalCreditCost ? `${selectedModel.name} uses ${totalCreditCost} credits${lipSyncEligible && lipSyncEnabled ? ' including lip-sync' : ''}` : 'Choose an engine to begin'}</div><button type="submit" disabled={isWorking || isUploading || prompt.trim().length < 3 || !selectedModelId || (voiceMode === 'text' && !voiceText.trim()) || (voiceMode === 'upload' && (!voiceFile || voiceFile.size === 0 || voiceFile.size > 20 * 1024 * 1024))} className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-3.5 text-sm font-bold text-background transition hover:-translate-y-0.5 hover:shadow-[4px_4px_0_hsl(var(--accent))] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" data-testid="button-generate">{isUploading ? <><LoaderCircle size={16} className="animate-spin" /> Uploading {uploadStage}</> : isWorking ? <><LoaderCircle size={16} className="animate-spin" /> Generating your video</> : <>Generate video <ArrowUpRight size={16} className="transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></>}</button></div>
    </div>
  </form>;
}

function PromptChip({ text, onClick }: { text: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="rounded-full border border-border px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition hover:border-foreground/40 hover:text-foreground" data-testid={`button-prompt-chip-${text.toLowerCase().replace(' ', '-')}`}>{text}</button>;
}

function VoiceRetryButton({ prediction }: { prediction: Prediction }) {
  const queryClient = useQueryClient();
  const [isRetrying, setIsRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retryVoice = async () => {
    setIsRetrying(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/predictions/${encodeURIComponent(prediction.id)}/voice-retry`,
        { method: 'POST', credentials: 'include' },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'Could not retry voice generation.');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetPredictionQueryKey(prediction.id) }),
        queryClient.invalidateQueries({ queryKey: getListPredictionsQueryKey() }),
      ]);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Could not retry voice generation.');
    } finally {
      setIsRetrying(false);
    }
  };

  return <div className="mt-5">
    <button type="button" onClick={retryVoice} disabled={isRetrying} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-xs font-bold text-accent-foreground transition hover:bg-background hover:text-foreground disabled:cursor-wait disabled:opacity-60" data-testid="button-retry-voice">
      {isRetrying ? <><LoaderCircle size={14} className="animate-spin" /> Retrying voice…</> : <>Retry voice</>}
    </button>
    {error && <p role="alert" className="mt-2 text-xs text-[#ff9bac]" data-testid="text-voice-retry-error">{error}</p>}
  </div>;
}

function DownloadVideoButton({ prediction, dark = false }: { prediction: Prediction; dark?: boolean }) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadVideo = async () => {
    setIsDownloading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/predictions/${encodeURIComponent(prediction.id)}/download`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'Could not download this video.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `clicpai-${prediction.id.slice(0, 8)}.mp4`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Could not download this video.');
    } finally {
      setIsDownloading(false);
    }
  };

  return <div className="mt-5">
    <button type="button" onClick={downloadVideo} disabled={isDownloading} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-bold transition disabled:cursor-wait disabled:opacity-60 ${dark ? 'border border-background/20 text-background hover:bg-background hover:text-foreground' : 'bg-accent text-accent-foreground hover:bg-background hover:text-foreground'}`} data-testid="button-download-video">
      {isDownloading ? <><LoaderCircle size={14} className="animate-spin" /> Downloading video…</> : <><Download size={14} /> Download video</>}
    </button>
    {error && <p className={`mt-2 text-xs ${dark ? 'text-[#ff9bac]' : 'text-destructive'}`} data-testid="text-download-video-error">{error}</p>}
  </div>;
}

function voiceStatusOf(prediction: Prediction): string {
  return (prediction as Prediction & { voiceStatus?: string }).voiceStatus ?? 'none';
}

function isVoiceProcessing(prediction: Prediction): boolean {
  return ['pending', 'processing'].includes(voiceStatusOf(prediction))
    && prediction.status === 'processing'
    && (prediction.progress ?? 0) >= 95;
}

function isPredictionOngoing(prediction: Prediction): boolean {
  return !['succeeded', 'failed', 'canceled'].includes(prediction.status) || isVoiceProcessing(prediction) || prediction.refundPending;
}

function useRefundCreditUpdates(predictions: Prediction[]) {
  const seenRefunds = useRef(new Set<string>());
  useEffect(() => {
    let hasNewRefund = false;
    for (const prediction of predictions) {
      if (prediction.creditsRefunded && !seenRefunds.current.has(prediction.id)) {
        seenRefunds.current.add(prediction.id);
        hasNewRefund = true;
      }
    }
    if (hasNewRefund) window.dispatchEvent(new Event('credits:updated'));
  }, [predictions]);
}

function GenerationProgress({ prediction, onCreated }: { prediction: Prediction; onCreated: (prediction: Prediction) => void }) {
  const progress = Math.max(0, Math.min(100, prediction.progress ?? 0));
  const voiceStatus = voiceStatusOf(prediction);
  const isVoiceFailed = voiceStatus === 'failed';
  const isFailed = !isVoiceFailed && (prediction.status === 'failed' || prediction.status === 'canceled');
  const isVoiceRunning = isVoiceProcessing(prediction);
  return <section className="mt-7 rounded-2xl border border-border bg-foreground p-5 text-background sm:p-6" data-testid="panel-generation-progress">
     <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${isFailed || isVoiceFailed ? 'bg-destructive' : prediction.status === 'succeeded' && !isVoiceRunning ? 'bg-[#72cbb4]' : 'bg-accent pulse-line'}`} /><span className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-background/55">{isVoiceRunning ? prediction.lipSyncEnabled ? 'Lip-syncing' : 'Adding voice' : formatStatus(prediction.status)}</span></div><h3 className="mt-3 max-w-lg font-display text-xl font-semibold leading-tight">{isVoiceFailed ? prediction.lipSyncEnabled ? 'Your video is ready, but lip-sync needs another try.' : 'Your video is ready, but voice generation needs another try.' : isVoiceRunning ? prediction.lipSyncEnabled ? 'Syncing your avatar to narration.' : 'Adding voice to your scene.' : prediction.status === 'succeeded' ? 'Your scene is ready to leave the studio.' : isFailed ? 'The render hit a snag.' : 'The studio is building your scene.'}</h3></div><span className="font-mono-ui text-xs text-accent">{prediction.status === 'succeeded' && !isVoiceRunning ? '100%' : `${Math.round(progress)}%`}</span></div>
    <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-background/10"><div className={`h-full rounded-full transition-all duration-700 ${isFailed ? 'bg-destructive' : 'bg-accent'}`} style={{ width: `${prediction.status === 'succeeded' ? 100 : progress}%` }} /></div>
    <div className="mt-4 flex items-center justify-between gap-4 text-xs text-background/45"><span className="max-w-[75%] truncate">{prediction.prompt}</span><span className="shrink-0 font-mono-ui">{prediction.duration}s / {prediction.aspectRatio}</span></div>
     {(isFailed || isVoiceFailed) && <p className="mt-4 border-t border-background/10 pt-4 text-xs text-background/65" data-testid="text-generation-error">{isVoiceFailed ? prediction.lipSyncEnabled ? 'The video was created, but lip-sync could not be saved.' : 'The video was created, but its voice could not be saved.' : prediction.error || 'Generation was canceled before an output could be created.'}</p>}
    {prediction.creditsRefunded && <p className="mt-3 text-xs font-semibold text-accent" data-testid="text-credits-refunded">{prediction.refundedCredits} credits were automatically returned to your account.</p>}
    {prediction.refundPending && <p className="mt-3 text-xs font-semibold text-accent" data-testid="text-refund-pending">Your credit refund is pending. We’ll retry it automatically.</p>}
    {isVoiceFailed && <VoiceRetryButton prediction={prediction} />}
     {prediction.status === 'succeeded' && prediction.outputUrl && !isVoiceRunning && <div className="flex flex-wrap items-start gap-3"><DownloadVideoButton prediction={prediction} dark /><AddSoundButton prediction={prediction} />{(prediction.voiceMode === 'none' || voiceStatus === 'succeeded') && <ContinueVideoButton prediction={prediction} videoUrl={`/api/predictions/${encodeURIComponent(prediction.id)}/video`} onCreated={onCreated} placement="progress" />}</div>}
  </section>;
}

function CreationCard({ prediction, onOpen }: { prediction: Prediction; onOpen: () => void }) {
  const completed = prediction.status === 'succeeded' && !!prediction.outputUrl;
  const voiceProcessing = isVoiceProcessing(prediction);
  const voiceFailed = voiceStatusOf(prediction) === 'failed';
  return <button type="button" onClick={onOpen} className="group overflow-hidden rounded-2xl border border-border bg-card text-left transition hover:-translate-y-1 hover:border-foreground/35 hover:shadow-[0_14px_30px_hsl(221_27%_15%/8%)]" data-testid={`card-creation-${prediction.id}`}>
     <div className="relative aspect-video overflow-hidden bg-secondary">{prediction.thumbnail ? <img src={mediaUrl(prediction.thumbnail, 'thumbnail')} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" /> : <div className="grid-paper flex h-full items-center justify-center"><Film size={24} className="text-muted-foreground/35" /></div>}<div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-foreground/70 to-transparent px-3 pb-3 pt-8"><span className="font-mono-ui text-[9px] uppercase tracking-[.15em] text-background/75">{prediction.aspectRatio}</span>{voiceProcessing ? <span className="rounded-full bg-accent px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[.1em] text-accent-foreground">{prediction.lipSyncEnabled ? 'Lip-syncing' : 'Adding voice'}</span> : voiceFailed ? <span className="rounded-full bg-destructive px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[.1em] text-background">{prediction.lipSyncEnabled ? 'Lip-sync failed' : 'Voice failed'}</span> : completed ? <span className="rounded-full bg-[#72cbb4] px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[.1em] text-foreground">Ready</span> : <span className="rounded-full bg-background/80 px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[.1em] text-foreground">{formatStatus(prediction.status)}</span>}</div></div>
    <div className="p-4"><p className="line-clamp-2 min-h-10 text-sm font-semibold leading-5">{prediction.prompt}</p>{prediction.creditsRefunded && <p className="mt-2 text-xs font-semibold text-accent-foreground" data-testid={`text-card-refunded-${prediction.id}`}>{prediction.refundedCredits} credits refunded</p>}{prediction.refundPending && <p className="mt-2 text-xs font-semibold text-accent-foreground" data-testid={`text-card-refund-pending-${prediction.id}`}>Refund pending · retrying automatically</p>}<div className="mt-3 flex items-center justify-between font-mono-ui text-[10px] text-muted-foreground"><span>{prediction.modelName}</span><span>{formatDate(prediction.createdAt)}</span></div></div>
  </button>;
}

function HomePage() {
  const modelsQuery = useListVideoModels({ query: { queryKey: getListVideoModelsQueryKey(), staleTime: 300000 } });
  const predictionsQuery = useListPredictions({ query: { queryKey: getListPredictionsQueryKey(), staleTime: 30000, refetchInterval: (query) => (query.state.data ?? []).some(isPredictionOngoing) ? 1800 : false } });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [createdPrediction, setCreatedPrediction] = useState<Prediction | undefined>();
  const [opened, setOpened] = useState<Prediction | undefined>();
  const predictions = predictionsQuery.data ?? [];
  useRefundCreditUpdates(predictions);
  const activeFromList = predictions.find((prediction) => prediction.id === activeId);
  const activePrediction = createdPrediction?.id === activeId ? createdPrediction : activeFromList;
  const getPredictionQuery = useGetPrediction(activeId ?? '', { query: { enabled: !!activeId, queryKey: getGetPredictionQueryKey(activeId ?? ''), refetchInterval: activeId && activePrediction && isPredictionOngoing(activePrediction) ? 1800 : false } });
  useEffect(() => { if (getPredictionQuery.data) setCreatedPrediction(getPredictionQuery.data); }, [getPredictionQuery.data]);
  const models = modelsQuery.data ?? [];
  useEffect(() => { if (!selectedModelId && models[0]) setSelectedModelId(models[0].id); }, [models, selectedModelId]);
  const recent = useMemo(() => predictions.slice(0, 4), [predictions]);
  const openedPrediction = opened ? predictions.find((prediction) => prediction.id === opened.id) ?? opened : undefined;
  return <div className="mx-auto max-w-[1360px] px-5 py-10 md:px-10 md:py-14">
    <PageIntro eyebrow="01 / Create" title={<>Turn a thought into <span className="text-muted-foreground">a scene.</span></>} description="Describe the feeling, the movement, the moment. Video AI Store handles the timeline, the camera, and the cut." action={<div className="hidden items-center gap-2 rounded-full border border-border px-3 py-2 sm:flex"><Sparkles size={14} className="text-accent-foreground" /><span className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">One idea. One polished take.</span></div>} />
    <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.8fr)]">
       <div className="rise-in"><PromptComposer models={models} onCreated={(prediction) => { setActiveId(prediction.id); setCreatedPrediction(prediction); }} activePredictionId={activeId} activePrediction={activePrediction} selectedModelId={selectedModelId} onModelChange={setSelectedModelId} />{activePrediction && <GenerationProgress prediction={activePrediction} onCreated={(prediction) => { setActiveId(prediction.id); setCreatedPrediction(prediction); }} />}</div>
      <section className="rise-in rise-in-delay-1"><div className="mb-4 flex items-end justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-muted-foreground">02 / Studio engines</p><h2 className="mt-2 font-display text-2xl font-semibold tracking-[-.03em]">Choose your video engine.</h2></div></div>{modelsQuery.isLoading ? <div className="space-y-3">{[1, 2, 3].map((item) => <div key={item} className="h-[198px] animate-pulse rounded-2xl bg-muted" />)}</div> : modelsQuery.isError ? <ErrorState compact onRetry={() => modelsQuery.refetch()} /> : models.length ? <div className="space-y-3">{models.map((model) => <ModelCard key={model.id} model={model} selected={model.id === selectedModelId} onSelect={() => setSelectedModelId(model.id)} />)}</div> : <EmptyState icon={Layers3} title="No engines online" description="Video engines will appear here when available." />}</section>
    </div>
    <section className="mt-16 rise-in rise-in-delay-2"><div className="mb-5 flex items-end justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-muted-foreground">03 / Recent creations</p><h2 className="mt-2 font-display text-2xl font-semibold tracking-[-.03em]">Your latest cuts.</h2></div><Link href="/history" className="group flex items-center gap-1 text-xs font-bold text-muted-foreground transition hover:text-foreground" data-testid="link-view-history">View full history <ArrowUpRight size={14} className="transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></Link></div>{predictionsQuery.isLoading ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[1, 2, 3, 4].map((item) => <div key={item} className="aspect-[1.1] animate-pulse rounded-2xl bg-muted" />)}</div> : predictionsQuery.isError ? <ErrorState onRetry={() => predictionsQuery.refetch()} /> : recent.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{recent.map((prediction) => <CreationCard key={prediction.id} prediction={prediction} onOpen={() => setOpened(prediction)} />)}</div> : <EmptyState icon={Film} title="Your first cut is waiting" description="Start with a feeling above. Your finished scenes will land here." action={<Link href="#create" className="rounded-lg bg-foreground px-4 py-2 text-xs font-bold text-background" data-testid="link-start-first-cut">Start creating</Link>} />}</section>
     {openedPrediction && <VideoModal prediction={openedPrediction} onClose={() => setOpened(undefined)} onCreated={(prediction) => { setOpened(prediction); setActiveId(prediction.id); setCreatedPrediction(prediction); }} />}
  </div>;
}

function ErrorState({ onRetry, compact = false }: { onRetry: () => void; compact?: boolean }) {
  return <div className={`rounded-2xl border border-destructive/25 bg-destructive/5 text-center ${compact ? 'p-6' : 'p-10'}`}><p className="text-sm font-bold text-destructive">The studio is taking a breather.</p><p className="mt-1 text-xs text-muted-foreground">We could not load this part of the workspace.</p><button onClick={onRetry} className="mt-4 rounded-lg border border-destructive/30 px-3 py-2 text-xs font-bold text-destructive transition hover:bg-destructive/10" data-testid="button-retry">Try again</button></div>;
}

function EmptyState({ icon: Icon, title, description, action }: { icon: typeof Film; title: string; description: string; action?: ReactNode }) {
  return <div className="grid-paper rounded-2xl border border-dashed border-border p-10 text-center"><Icon size={23} className="mx-auto text-muted-foreground/50" /><p className="mt-4 font-display text-lg font-semibold">{title}</p><p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-muted-foreground">{description}</p>{action && <div className="mt-5">{action}</div>}</div>;
}

function VideoModal({ prediction: initialPrediction, onClose, onCreated }: { prediction: Prediction; onClose: () => void; onCreated: (prediction: Prediction) => void }) {
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const predictionQuery = useGetPrediction(initialPrediction.id, {
    query: {
      enabled: true,
      queryKey: getGetPredictionQueryKey(initialPrediction.id),
      refetchInterval: (query) => query.state.data && isPredictionOngoing(query.state.data) ? 1800 : false,
    },
  });
  const prediction = predictionQuery.data ?? initialPrediction;
  const videoUrl = mediaUrl(prediction.outputUrl, 'video');
  const voiceStatus = voiceStatusOf(prediction);
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-foreground/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Video output"><div className="relative max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl border border-background/10 bg-foreground shadow-2xl"><button onClick={onClose} className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-background/80 text-foreground transition hover:bg-accent" aria-label="Close video" data-testid="button-close-video"><X size={17} /></button>{videoUrl && !videoUnavailable ? <video src={videoUrl} controls autoPlay loop onError={() => setVideoUnavailable(true)} className="aspect-video w-full bg-black object-contain" /> : isVoiceProcessing(prediction) ? <div className="grid aspect-video place-items-center bg-black px-8 text-center text-background/75" data-testid="status-finishing-with-voice"><div><LoaderCircle size={30} className="mx-auto mb-4 animate-spin text-accent" /><p className="font-display text-lg font-semibold text-background">{prediction.lipSyncEnabled ? 'Lip-syncing your avatar' : 'Finishing your video with voice'}</p><p className="mt-2 max-w-md text-xs leading-5">{prediction.lipSyncEnabled ? 'Your narration is being used to sync the avatar’s mouth.' : 'Your video is ready. We’re adding the voice track now.'}</p></div></div> : <div className="grid aspect-video place-items-center bg-black px-8 text-center text-background/65" data-testid="status-video-unavailable"><div><Film size={28} className="mx-auto mb-4 opacity-50" /><p className="font-display text-lg font-semibold text-background">{videoUnavailable ? 'This older video has expired.' : 'No output available'}</p>{videoUnavailable && <p className="mt-2 max-w-md text-xs leading-5">It was created before permanent video saving was enabled, and the provider no longer has the original file.</p>}</div></div>}<div className="flex flex-col justify-between gap-3 p-5 text-background sm:flex-row sm:items-start"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-background/45">{prediction.modelName} · {prediction.duration}s</p><p className="mt-1 max-w-xl text-sm font-semibold">{prediction.prompt}</p>{isVoiceProcessing(prediction) && <p className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-accent"><LoaderCircle size={14} className="animate-spin text-accent" /> {prediction.lipSyncEnabled ? 'Lip-syncing narration' : 'Adding voice'}</p>}</div>{videoUrl && !videoUnavailable && prediction.status === 'succeeded' && !isVoiceProcessing(prediction) && <div className="flex shrink-0 flex-wrap items-center gap-2"><DownloadVideoButton prediction={prediction} dark /><AddSoundButton prediction={prediction} />{(prediction.voiceMode === 'none' || voiceStatus === 'succeeded') && <ContinueVideoButton prediction={prediction} videoUrl={`/api/predictions/${encodeURIComponent(prediction.id)}/video`} onCreated={onCreated} />}</div>}{voiceStatus === 'failed' && <div className="shrink-0"><VoiceRetryButton prediction={prediction} /></div>}</div></div></div>;
}

function HistoryPage() {
  const predictionsQuery = useListPredictions({ query: { queryKey: getListPredictionsQueryKey(), staleTime: 30000, refetchInterval: (query) => (query.state.data ?? []).some(isPredictionOngoing) ? 1800 : false } });
  const [filter, setFilter] = useState<'all' | 'succeeded' | 'processing'>('all');
  const [opened, setOpened] = useState<Prediction | undefined>();
  const predictions = predictionsQuery.data ?? [];
  useRefundCreditUpdates(predictions);
  const openedPrediction = opened ? predictions.find((prediction) => prediction.id === opened.id) ?? opened : undefined;
  const filtered = predictions.filter((prediction) => filter === 'all' || (filter === 'processing' ? ['starting', 'processing'].includes(prediction.status) : prediction.status === filter));
   return <div className="mx-auto max-w-[1360px] px-5 py-10 md:px-10 md:py-14"><PageIntro eyebrow="02 / History" title={<>Every take, <span className="text-muted-foreground">kept close.</span></>} description="A living archive of your prompts, experiments, and finished scenes. Pick up the thread whenever you are ready." action={<Link href="/studio" className="inline-flex items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-3 text-xs font-bold text-background transition hover:shadow-[4px_4px_0_hsl(var(--accent))]" data-testid="link-new-generation"><Plus size={15} /> New generation</Link>} /><div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4"><div className="flex gap-1 rounded-xl bg-muted p-1">{(['all', 'succeeded', 'processing'] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`rounded-lg px-3 py-2 text-xs font-bold capitalize transition ${filter === item ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`} data-testid={`button-filter-${item}`}>{item === 'all' ? 'All scenes' : item === 'succeeded' ? 'Finished' : 'In progress'}</button>)}</div><span className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">{filtered.length} scene{filtered.length === 1 ? '' : 's'}</span></div><div className="mt-7">{predictionsQuery.isLoading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[1, 2, 3, 4, 5, 6].map((item) => <div key={item} className="aspect-[1.1] animate-pulse rounded-2xl bg-muted" />)}</div> : predictionsQuery.isError ? <ErrorState onRetry={() => predictionsQuery.refetch()} /> : filtered.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{filtered.map((prediction) => <CreationCard key={prediction.id} prediction={prediction} onOpen={() => setOpened(prediction)} />)}</div> : <EmptyState icon={History} title={filter === 'all' ? 'No scenes in the archive' : 'Nothing in this filter'} description={filter === 'all' ? 'When you generate a scene, it will be saved here automatically.' : 'Try another filter or start a new generation.'} action={<Link href="/studio" className="rounded-lg bg-foreground px-4 py-2 text-xs font-bold text-background" data-testid="link-history-empty-create">Create a scene</Link>} />}</div>{openedPrediction && <VideoModal prediction={openedPrediction} onClose={() => setOpened(undefined)} onCreated={(prediction) => setOpened(prediction)} />}</div>;
}

function PricingPage() {
  const { user } = useUser();
  const pricingQuery = useGetBillingPlans({
    query: {
      queryKey: getGetBillingPlansQueryKey(),
      staleTime: 300000,
    },
  });
  const rates = pricingQuery.data?.rates;
  const [checkoutEmail, setCheckoutEmail] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(120);
  const [currency, setCurrency] = useState<'usd' | 'thb'>('thb');
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'promptpay'>('card');
  const [checkoutPending, setCheckoutPending] = useState(false);
  const checkoutMutation = useCreateBillingCheckout();
  const [billingError, setBillingError] = useState<string | null>(null);
  const [paymentVerified, setPaymentVerified] = useState(false);
  const [confirmedCredits, setConfirmedCredits] = useState<number | null>(null);
  const [confirmedPayment, setConfirmedPayment] = useState<{
    amount: number;
    currency: 'usd' | 'thb';
    durationSeconds: number;
  } | null>(null);
  const [paymentVerifying, setPaymentVerifying] = useState(false);
  const checkoutParams = new URLSearchParams(window.location.search);
  const checkoutStatus = checkoutParams.get('checkout');
  const checkoutSessionId = checkoutParams.get('session_id');
  const usdAmount = rates ? durationSeconds * rates.usdPerSecond : null;
  const thbAmount = rates ? durationSeconds * rates.thbPerSecond : null;
  const amount = currency === 'thb' ? thbAmount : usdAmount;
  useEffect(() => {
    if (!checkoutEmail && user?.primaryEmailAddress?.emailAddress) {
      setCheckoutEmail(user.primaryEmailAddress.emailAddress);
    }
  }, [checkoutEmail, user]);
  useEffect(() => {
    if (checkoutStatus !== 'success' || !checkoutSessionId) return;
    let active = true;
    setPaymentVerifying(true);
    fetch('/api/billing/checkout/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: checkoutSessionId }),
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          error?: string;
          creditsRemaining?: number;
          durationSeconds?: number;
          amount?: number;
          currency?: string;
        };
        if (!response.ok) throw new Error(body.error || 'Payment could not be verified.');
        if (active) {
          setPaymentVerified(true);
          setConfirmedCredits(body.creditsRemaining ?? null);
          if (
            typeof body.amount === 'number' &&
            typeof body.durationSeconds === 'number' &&
            (body.currency === 'usd' || body.currency === 'thb')
          ) {
            setConfirmedPayment({
              amount: body.amount,
              currency: body.currency,
              durationSeconds: body.durationSeconds,
            });
          }
          window.dispatchEvent(new Event('credits:updated'));
        }
      })
      .catch((error) => {
        if (active) setBillingError(error instanceof Error ? error.message : 'Payment could not be verified.');
      })
      .finally(() => {
        if (active) setPaymentVerifying(false);
      });
    return () => { active = false; };
  }, [checkoutSessionId, checkoutStatus]);
  const formatAmount = (value: number, unit: 'usd' | 'thb') =>
    unit === 'thb' ? `฿${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${value.toFixed(2)}`;

  const startCheckout = async (event: FormEvent) => {
    event.preventDefault();
    if (!checkoutEmail.trim()) {
      setBillingError('Enter your email to continue.');
      return;
    }
    if (!rates) {
      setBillingError('Current pricing is unavailable. Please try again shortly.');
      return;
    }

    setCheckoutPending(true);
    setBillingError(null);
    try {
      const checkout = await checkoutMutation.mutateAsync({
        data: {
          email: checkoutEmail.trim(),
          durationSeconds,
          currency,
          paymentMethod: currency === 'thb' ? paymentMethod : 'card',
        },
      });
      window.location.assign(checkout.url);
    } catch (error) {
      setBillingError(error instanceof Error ? error.message : 'Checkout is unavailable right now.');
      setCheckoutPending(false);
    }
  };

  return (
    <div className="dark relative min-h-[calc(100dvh-76px)] overflow-hidden bg-[#080b18] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(circle_at_15%_0%,rgba(95,71,255,.22),transparent_32%),radial-gradient(circle_at_90%_12%,rgba(46,210,196,.14),transparent_28%)]" />
      <div className="relative mx-auto max-w-[1240px] px-5 py-12 md:px-10 md:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="font-mono-ui text-[10px] uppercase tracking-[.28em] text-[#b8c0cc]">clicpai.com / pricing</p>
          <h1 className="mt-5 font-display text-4xl font-semibold tracking-[-.06em] text-white sm:text-6xl">Pay only for the <span className="bg-gradient-to-r from-[#d8dde5] to-[#8f99aa] bg-clip-text text-transparent">seconds you render.</span></h1>
          <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-white/55 sm:text-base">No subscriptions. No monthly fees. Choose a duration, review the exact cost, and pay securely with Stripe.</p>
        </div>
        <div className="mx-auto mt-14 grid max-w-[1120px] gap-5 lg:grid-cols-[1.05fr_.95fr]">
          <section className="rounded-[25px] border border-white/10 bg-white/[.045] p-7">
              <div className="flex items-start justify-between gap-4"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-white/45">Pay-as-you-go</p><div className="mt-4 grid grid-cols-2 gap-5"><div><p className="font-display text-3xl font-semibold text-white">{rates ? formatAmount(rates.usdPerSecond, 'usd') : '—'}</p><p className="font-mono-ui text-[10px] text-white/45">USD / second</p></div><div><p className="font-display text-3xl font-semibold text-white">{rates ? formatAmount(rates.thbPerSecond, 'thb') : '—'}</p><p className="font-mono-ui text-[10px] text-white/45">THB / second</p></div></div></div><Sparkles size={18} className="text-[#c7ced8]" /></div>
            <p className="mt-5 text-sm leading-6 text-white/55">Prepay the exact amount of AI video time you need, from a 10-second clip to a full three-minute edit.</p>
            <div className="my-7 h-px bg-white/10" />
              <div className="grid grid-cols-2 gap-3 text-sm">{rates ? [10, 15, 30, 60, 90, 120, 150, 180].map((seconds) => <div key={seconds} className="rounded-xl border border-white/10 bg-black/10 px-3 py-3 text-white/75"><span>{seconds}s</span><div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono-ui text-[11px] text-[#c7ced8]"><span>{formatAmount(seconds * rates.usdPerSecond, 'usd')}</span><span className="text-white/30">·</span><span>{formatAmount(seconds * rates.thbPerSecond, 'thb')}</span></div></div>) : <p className="col-span-2 text-xs text-white/55">{pricingQuery.isError ? 'Could not load current prices.' : 'Loading current prices…'}</p>}</div>
          </section>
          <section className="rounded-[25px] border border-[#c7ced8]/35 bg-[#10162d] p-7 shadow-[0_0_38px_rgba(184,192,204,.14)]">
            <p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#c7ced8]">Secure checkout</p><h2 className="mt-4 font-display text-3xl font-semibold text-white">Purchase render time.</h2>
            <form className="mt-7 space-y-4" onSubmit={startCheckout}>
              <div><label className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-white/45" htmlFor="checkout-duration">Video duration</label><select id="checkout-duration" value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))} className="w-full rounded-xl border border-white/15 bg-black/20 px-3 py-3 text-sm font-bold text-white outline-none focus:border-[#c7ced8]"><option value={10}>10 seconds</option><option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>60 seconds</option><option value={90}>90 seconds</option><option value={120}>120 seconds</option><option value={150}>150 seconds</option><option value={180}>180 seconds</option></select></div>
              <div><label className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-white/45" htmlFor="checkout-currency">Display currency</label><select id="checkout-currency" value={currency} onChange={(event) => { const nextCurrency = event.target.value as 'usd' | 'thb'; setCurrency(nextCurrency); if (nextCurrency === 'usd') setPaymentMethod('card'); }} className="w-full rounded-xl border border-white/15 bg-black/20 px-3 py-3 text-sm font-bold text-white outline-none focus:border-[#c7ced8]"><option value="thb">Thai baht (฿)</option><option value="usd">US dollars ($)</option></select></div>
              <fieldset>
                <legend className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-white/45">Payment method</legend>
                {currency === 'thb' ? (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition ${paymentMethod === 'card' ? 'border-[#c7ced8] bg-white/[.08]' : 'border-white/15 bg-black/20 hover:bg-white/[.04]'}`} data-testid="option-payment-card">
                        <input type="radio" name="checkout-payment-method" value="card" checked={paymentMethod === 'card'} onChange={() => setPaymentMethod('card')} className="mt-0.5 h-4 w-4 accent-[#c7ced8]" />
                        <span><span className="block text-sm font-semibold text-white">Card</span><span className="mt-1 block text-[11px] leading-4 text-white/45">Credit or debit card</span></span>
                      </label>
                      <label className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition ${paymentMethod === 'promptpay' ? 'border-[#c7ced8] bg-white/[.08]' : 'border-white/15 bg-black/20 hover:bg-white/[.04]'}`} data-testid="option-payment-promptpay">
                        <input type="radio" name="checkout-payment-method" value="promptpay" checked={paymentMethod === 'promptpay'} onChange={() => setPaymentMethod('promptpay')} className="mt-0.5 h-4 w-4 accent-[#c7ced8]" />
                        <span><span className="block text-sm font-semibold text-white">PromptPay</span><span className="mt-1 block text-[11px] leading-4 text-white/45">Scan a QR code to pay</span></span>
                      </label>
                    </div>
                    <p className="mt-2 text-[11px] leading-4 text-white/45">PromptPay checkout opens a QR code for your Thai banking app.</p>
                  </>
                ) : (
                  <div className="rounded-xl border border-white/15 bg-black/20 px-3 py-3">
                    <p className="text-sm font-semibold text-white">Card</p>
                    <p className="mt-1 text-[11px] leading-4 text-white/45">PromptPay is available for Thai baht purchases.</p>
                  </div>
                )}
              </fieldset>
              <div>
                <label className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[.16em] text-white/45" htmlFor="checkout-email">Payer email</label>
                <input id="checkout-email" type="email" required value={checkoutEmail} onChange={(event) => setCheckoutEmail(event.target.value)} placeholder="you@example.com" className="w-full rounded-xl border border-white/15 bg-black/20 px-3 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#c7ced8]" />
                <p className="mt-2 text-[11px] leading-4 text-white/45">This can differ from your sign-in email. Credits will go to the signed-in account.</p>
              </div>
                <div className="flex flex-col gap-4 border-t border-white/10 pt-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-white/45">Total · {currency === 'thb' ? `${paymentMethod === 'promptpay' ? 'PromptPay' : 'Card'} in Thai baht` : 'Card in USD'}</p><p className="mt-1 font-display text-3xl font-semibold text-white">{amount === null ? 'Loading…' : formatAmount(amount, currency)}</p><p className="mt-1 font-mono-ui text-[10px] text-white/45">{usdAmount === null || thbAmount === null ? 'Prices load from the server' : `USD ${formatAmount(usdAmount, 'usd')} · THB ${formatAmount(thbAmount, 'thb')}`}</p></div><button type="submit" disabled={checkoutPending || !rates} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#d8dde5] to-[#8f99aa] px-4 py-3 text-sm font-bold text-[#07101d] disabled:opacity-50" data-testid="button-live-checkout">{checkoutPending ? 'Preparing…' : 'Continue to payment'}<ArrowUpRight size={15} /></button></div>
            </form>
            {billingError && <p className="mt-4 text-xs text-red-200" data-testid="status-checkout-error">{billingError}</p>}
          </section>
        </div>
        {checkoutStatus === 'success' && paymentVerifying && <p className="mx-auto mt-8 max-w-xl rounded-xl border border-white/15 bg-white/[.04] px-4 py-3 text-center text-sm text-white/70">Verifying your Stripe payment…</p>}
        {checkoutStatus === 'success' && paymentVerified && <p className="mx-auto mt-8 max-w-xl rounded-xl border border-[#72cbb4]/30 bg-[#72cbb4]/10 px-4 py-3 text-center text-sm text-white/85">{confirmedPayment ? `Payment of ${formatAmount(confirmedPayment.amount / 100, confirmedPayment.currency)} received for ${confirmedPayment.durationSeconds} seconds.` : 'Payment verified.'} {confirmedCredits !== null && `Remaining credits: ${confirmedCredits}.`}</p>}
        {checkoutStatus === 'cancelled' && <p className="mx-auto mt-8 max-w-xl rounded-xl border border-white/15 bg-white/[.04] px-4 py-3 text-center text-sm text-white/70">Checkout was cancelled. You were not charged.</p>}
        <p className="mt-10 text-center font-mono-ui text-[10px] uppercase tracking-[.16em] text-white/30">Live Stripe checkout · prices shown before payment</p>
      </div>
    </div>
  );
}

function NotFound() {
  return <div className="grid min-h-[70dvh] place-items-center px-6 text-center"><div><p className="font-mono-ui text-xs uppercase tracking-[.2em] text-muted-foreground">404 / Out of frame</p><h1 className="mt-4 font-display text-5xl font-semibold">That scene is missing.</h1><Link href="/studio" className="mt-7 inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-3 text-xs font-bold text-background" data-testid="link-not-found-home">Return to studio <ArrowUpRight size={14} /></Link></div></div>;
}

function AboutPage() {
  useEffect(() => {
    const previousTitle = document.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousDescription = description?.content;
    document.title = 'About Clicpai — Private AI Photo-to-Video Studio';
    if (description) {
      description.content = 'Learn how Clicpai helps creators animate product and avatar photos into AI videos in a private studio, with generation history saved to their account.';
    }
    return () => {
      document.title = previousTitle;
      if (description && previousDescription) description.content = previousDescription;
    };
  }, []);
  return (
    <div className="app-noise min-h-[100dvh] bg-background px-5 py-6 text-foreground sm:px-8">
      <PublicHeader />
      <main className="mx-auto max-w-4xl py-16 sm:py-24">
        <p className="font-mono-ui text-[10px] uppercase tracking-[.24em] text-muted-foreground">About Clicpai</p>
        <h1 className="mt-5 max-w-3xl font-display text-5xl font-semibold leading-[.95] tracking-[-.06em] sm:text-7xl">Make your photos move.</h1>
        <p className="mt-7 max-w-2xl text-base leading-7 text-muted-foreground">Clicpai is a private AI video studio for bringing product photos and person or avatar photos to life. Upload an image, describe the scene, and create a video to keep in your account.</p>
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card p-5"><p className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">01 / Upload</p><h2 className="mt-3 font-display text-xl font-semibold">Start with a photo</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Use a product image or a person/avatar image as the starting point.</p></div>
          <div className="rounded-2xl border border-border bg-card p-5"><p className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">02 / Describe</p><h2 className="mt-3 font-display text-xl font-semibold">Set the scene</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Write a prompt and choose the video settings that fit your idea.</p></div>
          <div className="rounded-2xl border border-border bg-card p-5"><p className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">03 / Create</p><h2 className="mt-3 font-display text-xl font-semibold">Keep your takes</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Generate videos in your private studio and revisit them from your account.</p></div>
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-x-2 gap-y-3 border-t border-border pt-6 text-sm text-muted-foreground">
          <span>Questions?</span>
          <a href={`mailto:${contactEmail}`} className="font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">{contactEmail}</a>
          <Link href="/sign-up" className="ml-auto inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-3 text-xs font-bold text-background">Create an account <ArrowUpRight size={14} /></Link>
        </div>
      </main>
    </div>
  );
}

function LandingPage() {
  return (
    <div className="app-noise min-h-[100dvh] bg-background px-5 py-6 text-foreground sm:px-8">
      <PublicHeader />
      <main className="mx-auto grid min-h-[calc(100dvh-100px)] max-w-6xl items-center gap-10 py-12 lg:grid-cols-[1.05fr_.95fr] lg:gap-16">
        <div>
          <p className="font-mono-ui text-[10px] uppercase tracking-[.24em] text-muted-foreground">AI video studio</p>
          <h1 className="mt-5 max-w-3xl font-display text-5xl font-semibold leading-[.93] tracking-[-.06em] sm:text-7xl">Turn your photo into motion.</h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-muted-foreground">Upload a product photo or a person/avatar photo, describe the scene, and generate a video in your private studio.</p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/sign-up" className="inline-flex items-center gap-2 rounded-xl bg-foreground px-5 py-3.5 text-sm font-bold text-background">Create account to upload <ArrowUpRight size={16} /></Link>
            <Link href="/sign-in" className="inline-flex items-center rounded-xl border border-border px-5 py-3.5 text-sm font-bold">I have an account</Link>
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">Sign in first so your photos and videos stay private.</p>
        </div>
        <div className="relative overflow-hidden rounded-[30px] border border-border bg-foreground p-5 text-background shadow-[10px_10px_0_hsl(var(--accent))] sm:p-7">
          <div className="rounded-2xl border border-background/10 p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <span className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-background/50">Private studio · Photo to video</span>
              <span className="h-2 w-2 shrink-0 rounded-full bg-[#72cbb4]" />
            </div>
            <h2 className="mt-7 font-display text-3xl font-semibold leading-tight">Start with your photo.</h2>
            <p className="mt-2 text-sm leading-6 text-background/60">Choose what you want to bring to life.</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <Link href="/sign-up" className="flex items-center gap-3 rounded-xl border border-background/15 bg-background/5 p-4 transition hover:border-accent hover:bg-background/10" aria-label="Create an account to upload a product photo">
                <ImagePlus size={21} className="shrink-0 text-accent" /><span className="text-sm font-semibold">Product photo</span>
              </Link>
              <Link href="/sign-up" className="flex items-center gap-3 rounded-xl border border-background/15 bg-background/5 p-4 transition hover:border-accent hover:bg-background/10" aria-label="Create an account to upload a person or avatar photo">
                <Sparkles size={21} className="shrink-0 text-accent" /><span className="text-sm font-semibold">Person / avatar</span>
              </Link>
            </div>
            <Link href="/sign-in" className="mt-5 flex items-center justify-center gap-2 rounded-xl border border-dashed border-background/30 px-4 py-5 text-center text-sm font-bold transition hover:border-accent hover:bg-background/5">
              <ImagePlus size={19} /> Sign in to upload your photo <ArrowUpRight size={15} />
            </Link>
            <p className="mt-4 text-center text-xs text-background/45">Your uploads and finished videos stay in your account.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

function SignInPage() {
  return <div className="app-noise flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

function SignUpPage() {
  return <div className="app-noise flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

function HomeRedirect() {
  return <><Show when="signed-in"><Redirect to="/studio" /></Show><Show when="signed-out"><LandingPage /></Show></>;
}

function ProtectedStudio({ children }: { children: ReactNode }) {
  return <><Show when="signed-in"><AppShell>{children}</AppShell></Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClientInstance = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      queryClientInstance.clear();
    }
    previousUserId.current = userId;
  }), [addListener, queryClientInstance]);

  return null;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/about" component={AboutPage} /><Route path="/studio">{() => <ProtectedStudio><HomePage /></ProtectedStudio>}</Route><Route path="/pricing">{() => <ProtectedStudio><PricingPage /></ProtectedStudio>}</Route><Route path="/history">{() => <ProtectedStudio><HistoryPage /></ProtectedStudio>}</Route><Route>{() => <ProtectedStudio><NotFound /></ProtectedStudio>}</Route></Switch></ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to open your private studio' } }, signUp: { start: { title: 'Create your studio', subtitle: 'Keep your prompts and videos under one account' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider></ClerkProvider>;
}

function App() {
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
}

export default App;