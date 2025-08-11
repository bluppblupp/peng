-- Create profiles table for user information
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Create policies for profiles
CREATE POLICY "Users can view their own profile" 
ON public.profiles 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile" 
ON public.profiles 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own profile" 
ON public.profiles 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Create account groups for shared access (spouse, friends, flatmates)
CREATE TABLE public.account_groups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS for account groups
ALTER TABLE public.account_groups ENABLE ROW LEVEL SECURITY;

-- Create group memberships table
CREATE TABLE public.group_memberships (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES public.account_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- Enable RLS for group memberships
ALTER TABLE public.group_memberships ENABLE ROW LEVEL SECURITY;

-- Create connected banks table for user's bank connections
CREATE TABLE public.connected_banks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  connected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, account_id)
);

-- Enable RLS for connected banks
ALTER TABLE public.connected_banks ENABLE ROW LEVEL SECURITY;

-- Create policies for account groups
CREATE POLICY "Users can view groups they belong to" 
ON public.account_groups 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.group_memberships 
    WHERE group_id = account_groups.id AND user_id = auth.uid()
  )
);

CREATE POLICY "Group owners can update their groups" 
ON public.account_groups 
FOR UPDATE 
USING (created_by = auth.uid());

CREATE POLICY "Users can create account groups" 
ON public.account_groups 
FOR INSERT 
WITH CHECK (created_by = auth.uid());

-- Create policies for group memberships
CREATE POLICY "Users can view memberships in their groups" 
ON public.group_memberships 
FOR SELECT 
USING (
  user_id = auth.uid() OR 
  EXISTS (
    SELECT 1 FROM public.group_memberships gm 
    WHERE gm.group_id = group_memberships.group_id 
    AND gm.user_id = auth.uid() 
    AND gm.role IN ('owner', 'admin')
  )
);

CREATE POLICY "Group admins can manage memberships" 
ON public.group_memberships 
FOR ALL 
USING (
  EXISTS (
    SELECT 1 FROM public.group_memberships gm 
    WHERE gm.group_id = group_memberships.group_id 
    AND gm.user_id = auth.uid() 
    AND gm.role IN ('owner', 'admin')
  )
);

-- Create policies for connected banks
CREATE POLICY "Users can view their own connected banks" 
ON public.connected_banks 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own connected banks" 
ON public.connected_banks 
FOR ALL 
USING (auth.uid() = user_id);

-- Create function to automatically create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (new.id, new.raw_user_meta_data ->> 'display_name');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for automatic profile creation
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Create function to update timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for automatic timestamp updates
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_account_groups_updated_at
  BEFORE UPDATE ON public.account_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();