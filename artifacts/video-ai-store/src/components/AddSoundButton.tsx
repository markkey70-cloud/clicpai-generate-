import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Download, LoaderCircle, Music2, Upload, X } from 'lucide-react';
import type { Prediction } from '@workspace/api-client-react';

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export function AddSoundButton({ prediction }: { prediction: Prediction }) {
  const [isOpen, setIsOpen] = useState(false);
  const [source, setSource] = useState<'generate' | 'upload'>('generate');
  const [kind, setKind] = useState<'music' | 'effects'>('music');
  const [prompt, setPrompt] = useState(prediction.prompt.slice(0, 1000));
  const [file, setFile] = useState<File | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  useEffect(() => () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isWorking) setIsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isWorking]);

  async function createVideo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isWorking) return;
    const description = prompt.trim();
    if (source === 'generate' && description.length < 3) {
      setError('Describe the music or sound effect first.');
      return;
    }
    if (source === 'upload' && (!file || file.size === 0 || file.size > MAX_AUDIO_BYTES)) {
      setError('Choose an audio file up to 20 MB.');
      return;
    }

    setIsWorking(true);
    setError(null);
    setResultUrl(null);
    try {
      const endpoint = `/api/predictions/${encodeURIComponent(prediction.id)}/${source === 'generate' ? 'sound' : 'sound-upload'}`;
      const response = await fetch(endpoint, source === 'generate'
        ? {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: description, kind }),
          }
        : {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'Could not add sound to this video.');
      }
      const video = await response.blob();
      if (!video.size) throw new Error('The sound export was empty. Please try again.');
      setResultUrl(URL.createObjectURL(video));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not add sound to this video.');
    } finally {
      setIsWorking(false);
    }
  }

  return <>
    <button type="button" onClick={() => setIsOpen(true)} className="mt-5 inline-flex items-center gap-2 rounded-lg border border-background/20 px-4 py-2.5 text-xs font-bold text-background transition hover:bg-background hover:text-foreground" data-testid="button-add-sound">
      <Music2 size={14} /> Add sound
    </button>
    {isOpen && createPortal(<div className="fixed inset-0 z-[80] overflow-y-auto bg-foreground/80 p-4 backdrop-blur-sm">
      <div className="flex min-h-full items-center justify-center">
        <div role="dialog" aria-modal="true" aria-label="Add sound to video" className="relative w-full max-w-xl rounded-2xl border border-border bg-background p-5 text-foreground shadow-2xl sm:p-7">
          <button type="button" onClick={() => setIsOpen(false)} disabled={isWorking} className="absolute right-4 top-4 rounded-lg p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label="Close Add sound" data-testid="button-close-add-sound"><X size={18} /></button>
          <p className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-muted-foreground">Sound studio</p>
          <h2 className="mt-2 font-display text-2xl font-semibold">Add sound to your video</h2>
          <p className="mt-1 text-sm text-muted-foreground">Make a short instrumental or effect, or add audio you have rights to use. No new narration is added.</p>

          <div className="mt-6 flex rounded-xl bg-muted p-1" role="tablist" aria-label="Sound source">
            <button type="button" role="tab" aria-selected={source === 'generate'} onClick={() => { setSource('generate'); setError(null); }} className={`flex-1 rounded-lg px-3 py-2.5 text-xs font-bold transition ${source === 'generate' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`} data-testid="tab-generate-sound">Generate from prompt</button>
            <button type="button" role="tab" aria-selected={source === 'upload'} onClick={() => { setSource('upload'); setError(null); }} className={`flex-1 rounded-lg px-3 py-2.5 text-xs font-bold transition ${source === 'upload' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`} data-testid="tab-upload-sound">Upload my audio</button>
          </div>

          <form onSubmit={createVideo} className="mt-5">
            {source === 'generate' ? <>
              <div className="flex gap-2">
                {(['music', 'effects'] as const).map((option) => <button type="button" key={option} onClick={() => setKind(option)} aria-pressed={kind === option} className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${kind === option ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'}`} data-testid={`button-sound-kind-${option}`}>{option === 'music' ? 'Instrumental music' : 'Sound effects'}</button>)}
              </div>
              <label htmlFor={`sound-prompt-${prediction.id}`} className="mt-4 block text-xs font-bold">Sound prompt</label>
              <textarea id={`sound-prompt-${prediction.id}`} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={1000} rows={4} autoFocus placeholder="A 1990s-inspired hip-hop beat with deep drums and warm bass…" className="mt-2 w-full resize-y rounded-xl border border-input bg-card px-3 py-3 text-sm outline-none transition focus:border-foreground" data-testid="input-sound-prompt" />
              <p className="mt-2 text-xs text-muted-foreground">Edit the video prompt above to describe the soundtrack you want. The first generation can take a few minutes.</p>
              <p className="mt-3 text-[11px] text-muted-foreground">Powered by Stability AI · <a href="https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE.md" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">License terms</a></p>
            </> : <>
              <label htmlFor={`sound-file-${prediction.id}`} className="block text-xs font-bold">Choose an audio track</label>
              <label className="mt-2 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-5 text-sm font-semibold transition hover:border-foreground/50">
                <Upload size={18} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{file ? file.name : 'Select MP3, WAV, M4A, or another audio file'}</span>
                <input id={`sound-file-${prediction.id}`} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac" className="sr-only" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null); }} data-testid="input-sound-file" />
              </label>
              <p className="mt-2 text-xs text-muted-foreground">Up to 20 MB. Use only audio you own or have permission to include in this video.</p>
            </>}

            {error && <p role="alert" className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive" data-testid="text-add-sound-error">{error}</p>}
            <button type="submit" disabled={isWorking || (source === 'generate' ? prompt.trim().length < 3 : !file)} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-bold text-background transition hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-create-sound-video">
              {isWorking ? <><LoaderCircle size={17} className="animate-spin" /> {source === 'generate' ? 'Generating sound…' : 'Adding audio…'}</> : <><Music2 size={17} /> Preview video with sound</>}
            </button>
          </form>

          {resultUrl && <div className="mt-6 border-t border-border pt-5" data-testid="panel-sound-preview">
            <p className="mb-3 text-sm font-bold">Your video with sound</p>
            <video src={resultUrl} controls playsInline className="aspect-video w-full rounded-xl bg-black object-contain" />
            <a href={resultUrl} download={`clicpai-${prediction.id.slice(0, 8)}-with-sound.mp4`} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-xs font-bold transition hover:border-foreground" data-testid="link-download-sound-video"><Download size={15} /> Download with sound</a>
            <p className="mt-2 text-xs text-muted-foreground">This preview is temporary. Download the video to keep the sound.</p>
          </div>}
        </div>
      </div>
    </div>, document.body)}
  </>;
}