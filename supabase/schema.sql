-- متجر صفصف: جداول قاعدة البيانات وقواعد الحماية
-- شغّل هذا الملف مرة وحدة من Supabase: SQL Editor ← New query ← الصق ← Run

-- 1) جدول واحد لكل البيانات (القطع، الطلبات، العملاء، الحملات، الإعدادات)
create table if not exists public.items (
  owner      uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, kind, id)
);

-- 2) الحماية: كل مستخدم يشوف ويعدّل بياناته هو بس
alter table public.items enable row level security;

drop policy if exists "owner can read"   on public.items;
drop policy if exists "owner can insert" on public.items;
drop policy if exists "owner can update" on public.items;
drop policy if exists "owner can delete" on public.items;

create policy "owner can read"   on public.items for select to authenticated using (owner = auth.uid());
create policy "owner can insert" on public.items for insert to authenticated with check (owner = auth.uid());
create policy "owner can update" on public.items for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner can delete" on public.items for delete to authenticated using (owner = auth.uid());

revoke all on public.items from anon;
grant select, insert, update, delete on public.items to authenticated;

-- 3) التحديث المباشر بين الأجهزة (الجوال والكمبيوتر)
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; end $$;

-- 4) مكان صور المنتجات (عام للقراءة عشان تنرسل للعملاء، والرفع لك أنت بس)
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "owner uploads images" on storage.objects;
drop policy if exists "owner updates images" on storage.objects;
drop policy if exists "owner deletes images" on storage.objects;

create policy "owner uploads images" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner updates images" on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner deletes images" on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
