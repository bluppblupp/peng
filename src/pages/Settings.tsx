import { useState, useEffect } from 'react'
import { Header } from '@/components/Header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { CurrencySelector } from '@/components/CurrencySelector'
import { useAuth } from '@/contexts/AuthContext'
import { supabase } from '@/integrations/supabase/client'
import { useToast } from '@/hooks/use-toast'
import { Trash2, Plus, Settings as SettingsIcon, Users } from 'lucide-react'
import { CurrencyProvider } from '@/contexts/CurrencyContext'

interface ConnectedBank {
  id: string
  bank_name: string
  account_id: string
  is_active: boolean
  connected_at: string
}

interface AccountGroup {
  id: string
  name: string
  role: string
  created_at: string
}

const Settings = () => {
  const { user, loading, signOut } = useAuth()
  const { toast } = useToast()
  const [connectedBanks, setConnectedBanks] = useState<ConnectedBank[]>([])
  const [accountGroups, setAccountGroups] = useState<AccountGroup[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/'
    } else if (user) {
      loadUserData()
    }
  }, [user, loading])

  const loadUserData = async () => {
    if (!user) return

    // Load connected banks
    const { data: banks } = await supabase
      .from('connected_banks')
      .select('*')
      .eq('user_id', user.id)
      .order('connected_at', { ascending: false })

    if (banks) setConnectedBanks(banks)

    // Load account groups
    const { data: groups } = await supabase
      .from('group_memberships')
      .select(`
        group_id,
        role,
        account_groups!inner (
          id,
          name,
          created_at
        )
      `)
      .eq('user_id', user.id)

    if (groups) {
      const formattedGroups = groups.map(g => ({
        id: g.account_groups.id,
        name: g.account_groups.name,
        role: g.role,
        created_at: g.account_groups.created_at
      }))
      setAccountGroups(formattedGroups)
    }

    // Load user profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('user_id', user.id)
      .single()

    if (profile) {
      setDisplayName(profile.display_name || '')
    }
  }

  const updateProfile = async () => {
    if (!user || !displayName.trim()) return

    const { error } = await supabase
      .from('profiles')
      .update({ display_name: displayName })
      .eq('user_id', user.id)

    if (error) {
      toast({
        title: "Update failed",
        description: error.message,
        variant: "destructive"
      })
    } else {
      toast({
        title: "Profile updated",
        description: "Your display name has been updated successfully"
      })
    }
  }

  const updatePassword = async () => {
    if (!newPassword || newPassword !== confirmPassword) {
      toast({
        title: "Password mismatch",
        description: "Please ensure both password fields match",
        variant: "destructive"
      })
      return
    }

    const { error } = await supabase.auth.updateUser({
      password: newPassword
    })

    if (error) {
      toast({
        title: "Password update failed",
        description: error.message,
        variant: "destructive"
      })
    } else {
      toast({
        title: "Password updated",
        description: "Your password has been updated successfully"
      })
      setNewPassword('')
      setConfirmPassword('')
    }
  }

  const createAccountGroup = async () => {
    if (!user || !newGroupName.trim()) {
      console.log('Missing user or group name:', { user: !!user, groupName: newGroupName })
      return
    }

    console.log('Creating account group:', { name: newGroupName, userId: user.id })

    const { data: group, error } = await supabase
      .from('account_groups')
      .insert({ name: newGroupName, created_by: user.id })
      .select()
      .single()

    if (error) {
      console.error('Group creation error:', error)
      toast({
        title: "Group creation failed",
        description: error.message,
        variant: "destructive"
      })
      return
    }

    console.log('Group created successfully:', group)

    // Add creator as owner
    const { error: membershipError } = await supabase
      .from('group_memberships')
      .insert({
        group_id: group.id,
        user_id: user.id,
        role: 'owner'
      })

    if (membershipError) {
      console.error('Membership creation error:', membershipError)
      toast({
        title: "Membership creation failed",
        description: membershipError.message,
        variant: "destructive"
      })
      return
    }

    console.log('Membership created successfully')

    setNewGroupName('')
    loadUserData()
    toast({
      title: "Group created",
      description: "Your account group has been created successfully"
    })
  }

  const disconnectBank = async (bankId: string) => {
    const { error } = await supabase
      .from('connected_banks')
      .delete()
      .eq('id', bankId)

    if (error) {
      toast({
        title: "Disconnect failed",
        description: error.message,
        variant: "destructive"
      })
    } else {
      loadUserData()
      toast({
        title: "Bank disconnected",
        description: "Your bank account has been disconnected"
      })
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (!user) {
    return null
  }

  return (
    <CurrencyProvider>
      <div className="min-h-screen bg-background">
        <Header />
        
        <main className="container mx-auto px-4 py-8">
          <div className="flex items-center gap-3 mb-8">
            <SettingsIcon className="h-8 w-8 text-primary" />
            <h1 className="text-3xl font-bold">Settings</h1>
          </div>

          <Tabs defaultValue="profile" className="space-y-6">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="currency">Currency</TabsTrigger>
              <TabsTrigger value="banks">Banks</TabsTrigger>
              <TabsTrigger value="groups">Groups</TabsTrigger>
            </TabsList>

            <TabsContent value="profile">
              <Card>
                <CardHeader>
                  <CardTitle>Profile Settings</CardTitle>
                  <CardDescription>
                    Manage your account information
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="display-name">Display Name</Label>
                    <div className="flex gap-2">
                      <Input
                        id="display-name"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Your display name"
                      />
                      <Button onClick={updateProfile}>Update</Button>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-4">
                    <h3 className="text-lg font-medium">Change Password</h3>
                    <div className="space-y-2">
                      <Label htmlFor="new-password">New Password</Label>
                      <Input
                        id="new-password"
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Enter new password"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirm-password">Confirm Password</Label>
                      <Input
                        id="confirm-password"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Confirm new password"
                      />
                    </div>
                    <Button onClick={updatePassword}>Update Password</Button>
                  </div>

                  <Separator />

                  <div>
                    <Button variant="destructive" onClick={signOut}>
                      Sign Out
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="currency">
              <Card>
                <CardHeader>
                  <CardTitle>Currency Preferences</CardTitle>
                  <CardDescription>
                    Set your preferred currency for displaying amounts
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <Label>Current Currency</Label>
                    <CurrencySelector />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="banks">
              <Card>
                <CardHeader>
                  <CardTitle>Connected Banks</CardTitle>
                  <CardDescription>
                    Manage your connected bank accounts
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {connectedBanks.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">
                      No banks connected yet. Go to the dashboard to connect your first bank account.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {connectedBanks.map((bank) => (
                        <div key={bank.id} className="flex items-center justify-between p-4 border rounded-lg">
                          <div>
                            <h4 className="font-medium">{bank.bank_name}</h4>
                            <p className="text-sm text-muted-foreground">
                              Connected on {new Date(bank.connected_at).toLocaleDateString()}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant={bank.is_active ? "default" : "secondary"}>
                              {bank.is_active ? "Active" : "Inactive"}
                            </Badge>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => disconnectBank(bank.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="groups">
              <Card>
                <CardHeader>
                  <CardTitle>Account Groups</CardTitle>
                  <CardDescription>
                    Share expenses with family, friends, or flatmates
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex gap-2">
                    <Input
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="Group name (e.g., Family, Flatmates)"
                    />
                    <Button onClick={createAccountGroup}>
                      <Plus className="h-4 w-4 mr-2" />
                      Create
                    </Button>
                  </div>

                  {accountGroups.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">
                      No account groups yet. Create one to share expenses with others.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {accountGroups.map((group) => (
                        <div key={group.id} className="flex items-center justify-between p-4 border rounded-lg">
                          <div className="flex items-center gap-3">
                            <Users className="h-5 w-5 text-muted-foreground" />
                            <div>
                              <h4 className="font-medium">{group.name}</h4>
                              <p className="text-sm text-muted-foreground">
                                Created {new Date(group.created_at).toLocaleDateString()}
                              </p>
                            </div>
                          </div>
                          <Badge variant="outline">{group.role}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </CurrencyProvider>
  )
}

export default Settings