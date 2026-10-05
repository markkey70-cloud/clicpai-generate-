create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  credits_remaining integer not null default 0 check (credits_remaining >= 0),
  generations_used integer not null default 0 check (generations_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  alter column credits_remaining set default 0;

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('starting', 'processing', 'succeeded', 'failed', 'canceled')),
  prompt text not null,
  model_id text not null,
  model_name text not null,
  aspect_ratio text not null,
  duration integer not null,
  output_url text,
  error text,
  created_at timestamptz not null default now(),
  progress integer not null default 0 check (progress between 0 and 100),
  thumbnail text,
  credit_cost integer not null check (credit_cost >= 0)
);

create index if not exists predictions_user_created_idx
  on public.predictions(user_id, created_at desc);

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  kind text not null check (kind in ('signup', 'generation', 'refund', 'purchase', 'adjustment')),
  prediction_id uuid references public.predictions(id) on delete set null,
  balance_after integer not null check (balance_after >= 0),
  created_at timestamptz not null default now()
);

create unique index if not exists credit_transactions_generation_idx
  on public.credit_transactions(prediction_id)
  where kind = 'generation';

create index if not exists credit_transactions_purchase_user_idx
  on public.credit_transactions(user_id)
  where kind = 'purchase' and amount > 0;

alter table public.profiles enable row level security;
alter table public.predictions enable row level security;
alter table public.credit_transactions enable row level security;

drop policy if exists "Users can read their profile" on public.profiles;
create policy "Users can read their profile"
  on public.profiles for select
  using (auth.uid() = user_id);

drop policy if exists "Users can read their predictions" on public.predictions;
create policy "Users can read their predictions"
  on public.predictions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can read their credit transactions" on public.credit_transactions;
create policy "Users can read their credit transactions"
  on public.credit_transactions for select
  using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data->>'display_name', '')), '')
  )
  on conflict (user_id) do update
    set email = excluded.email,
        display_name = coalesce(excluded.display_name, public.profiles.display_name),
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute procedure public.handle_new_user();

insert into public.profiles (user_id, email, display_name)
select
  id,
  coalesce(email, ''),
  nullif(trim(coalesce(raw_user_meta_data->>'display_name', '')), '')
from auth.users
on conflict (user_id) do update
  set email = excluded.email,
      display_name = coalesce(excluded.display_name, public.profiles.display_name),
      updated_at = now();

create or replace function public.create_prediction_with_credits(
  p_user_id uuid,
  p_prompt text,
  p_model_id text,
  p_model_name text,
  p_aspect_ratio text,
  p_duration integer,
  p_credit_cost integer
)
returns public.predictions
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_profile public.profiles;
  created_prediction public.predictions;
begin
  if p_credit_cost < 0 then
    raise exception 'invalid_credit_cost';
  end if;

  update public.profiles
  set credits_remaining = credits_remaining - p_credit_cost,
      generations_used = generations_used + 1,
      updated_at = now()
  where user_id = p_user_id
    and credits_remaining >= p_credit_cost
    and exists (
      select 1
      from public.credit_transactions
      where user_id = p_user_id
        and kind = 'purchase'
        and amount > 0
    )
  returning * into updated_profile;

  if updated_profile.user_id is null then
    raise exception 'insufficient_credits';
  end if;

  insert into public.predictions (
    user_id,
    status,
    prompt,
    model_id,
    model_name,
    aspect_ratio,
    duration,
    progress,
    credit_cost
  )
  values (
    p_user_id,
    'starting',
    p_prompt,
    p_model_id,
    p_model_name,
    p_aspect_ratio,
    p_duration,
    12,
    p_credit_cost
  )
  returning * into created_prediction;

  insert into public.credit_transactions (
    user_id,
    amount,
    kind,
    prediction_id,
    balance_after
  )
  values (
    p_user_id,
    -p_credit_cost,
    'generation',
    created_prediction.id,
    updated_profile.credits_remaining
  );

  return created_prediction;
end;
$$;

revoke all on function public.create_prediction_with_credits(uuid, text, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_prediction_with_credits(uuid, text, text, text, text, integer, integer)
  to service_role;