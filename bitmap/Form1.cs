using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Newtonsoft.Json;

namespace bitmap
{
    public partial class Form1 : Form
    {
        // A* algorithm
        //use map and go in a direction to identify a wall, if there is a wall cannot try that direction again
        // end points and start points
        [DllImport("user32.dll")]
        public static extern int SetActiveWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern int SetForegroundWindow(IntPtr hwnd);

        //
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
        //
        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll", CharSet = CharSet.Auto, CallingConvention = CallingConvention.StdCall)]
        public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);

        [DllImport("user32.dll", EntryPoint = "SetCursorPos")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetCursorPos(int x, int y);
        //Mouse actions & Fkeys
        [DllImport("user32.dll")]
        static extern uint MapVirtualKeyEx(uint uCode, uint uMapType, IntPtr dwhkl);

        const uint MAPVK_VK_TO_VSC = 0x00;
        private const int BM_CLICK = 0x00F5;
        private const int MOUSEEVENTF_LEFTDOWN = 0x02;
        private const int MOUSEEVENTF_LEFTUP = 0x04;
        private const int MOUSEEVENTF_RIGHTDOWN = 0x08;
        private const int MOUSEEVENTF_RIGHTUP = 0x10;
        private const int WM_MOUSEMOVE = 0x0200;
        private const int WM_LBUTTONDOWN = 0x0201;
        private const int WM_LBUTTONUP = 0x0202;
        private const int WM_KEYDOWN = 0x0100;
        private const int VK_LBUTTON = 0x01;
        private const int VK_D = 0x44;
        private const int VK_ESCAPE = 0x1B;
        private const int VK_W = 0x57;
        private const int VK_B = 0x42;
        private const int VK_F1 = 0x70;
        private const int VK_1 = 0x31;
        private const int VK_2 = 0x32;
        private const int VK_F2 = 0x71;
        private const int VK_F3 = 0x72;
        private const int VK_F4 = 0x73;
        private const int VK_F5 = 0x74;
        private const int VK_F6 = 0x75;
        private const int VK_F7 = 0x76;
        private const int VK_F8 = 0x77;
        private const int VK_F9 = 0x78;
        private const int VK_F10 = 0x79;
        private const int VK_F11 = 0x7A;
        private const int VK_F12 = 0x7B;



        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;        // x position of upper-left corner
            public int Top;         // y position of upper-left corner
            public int Right;       // x position of lower-right corner
            public int Bottom;      // y position of lower-right corner
        }


        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string lclassName, string windowTitle);

        public static IntPtr HWND;
        public static Process OwnerProcess;
        public static RECT RT;
        public Rectangle MyRect = new Rectangle();
        public double MinDistance;
        public bool SellItems;
        public bool IsPlayedShop;
        public bool Active;


        public PixelLocation MinCoord;
        public RECT rt;
        public Bitmap OverallScreenBitmap;
        public List<Pixelcolor> PixelColorList = new List<Pixelcolor>();
        public List<PixelLocation> MonsterPixelList = new List<PixelLocation>();
        public List<PixelLocation> DungeonPixelList = new List<PixelLocation>();
        public List<PixelLocation> OpenAreaPixelList = new List<PixelLocation>();
        public List<PixelLocation> TraversablePixelList = new List<PixelLocation>();
        public List<Tile> WallTileList = new List<Tile>();


        public List<Tile> ActiveTiles = new List<Tile>();
        public List<Tile> VisitedTiles = new List<Tile>();

        public PixelLocation Character;
        public PixelLocation MapCharacter;
        public PixelLocation PreviousPosition;

        public Bitmap MapBitmap;
        public Bitmap PreviousMap;
        public Tile PreviousTile;

        public PixelLocation MapTopLeftPixel;
        public PixelLocation MapBottomRightPixel;
        public Area PrajnaVillage;
        public Area CurrentArea = new Area();


        //StopWatches
        Stopwatch RightClickStopWatch = new Stopwatch();
        Stopwatch F1StopWatch = new Stopwatch();
        Stopwatch F2StopWatch = new Stopwatch();
        Stopwatch F3StopWatch = new Stopwatch();
        Stopwatch F4StopWatch = new Stopwatch();
        Stopwatch F5StopWatch = new Stopwatch();
        Stopwatch F6StopWatch = new Stopwatch();
        Stopwatch F7StopWatch = new Stopwatch();
        Stopwatch F8StopWatch = new Stopwatch();
        Stopwatch F9StopWatch = new Stopwatch();
        Stopwatch F10StopWatch = new Stopwatch();
        Stopwatch F11StopWatch = new Stopwatch();
        Stopwatch F12StopWatch = new Stopwatch();
        Stopwatch N1StopWatch = new Stopwatch();
        Stopwatch PickUpStopWatch = new Stopwatch();
        Stopwatch SellItemsStopWatch = new Stopwatch();



        public static IntPtr BuildLParam(uint low, uint high)
        {
            return (IntPtr)(((uint)high << 16) | (uint)low);
        }

        public Form1()
        {
            InitializeComponent();
            //Find handle & handle info
            HWND = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null, "Legend of Mir III - Xtreme Edition");

            SellItems = false;
            GetWindowRect(HWND, out rt);
            Active = true;
            MyRect.X = rt.Left;
            MyRect.Y = rt.Top;
            MyRect.Width = rt.Right - rt.Left;
            MyRect.Height = rt.Bottom - rt.Top;

        }


        private void AttackButton_Click(object sender, EventArgs e)
        {
            List<PixelLocation> pixelList = new List<PixelLocation>();
            //Set stop watches to time buffs/TT
            //var stopwatch = new Stopwatch();
            //var gameStopwatch = Stopwatch.StartNew();
            //gameStopwatch.Start();
            PickUpStopWatch.Start();
            SellItemsStopWatch.Start();

            int counter = 0;
            do
            {
                MakeBitmap();
                // FindDestinations();
                LockandReadImage(OverallScreenBitmap); // also attacks for now
                AttackChecker();
                if (PickUpStopWatch.ElapsedMilliseconds / 1000 > 5)
                {
                    PickUpStopWatch.Restart();
                    PickUpItems();
                }
                if (SellItemsCheckBox.Checked == true && SellItemsStopWatch.ElapsedMilliseconds / 1000 > 10) 
                {
                    SellItemsStopWatch.Restart();
                    SellItem();
                }

            } while (Active == true);


        }

        private void TravelButton_Click(object sender, EventArgs e)
        {
            int counter = 0;
            string targetArea = (string)SearchCurrentAreaListBox.SelectedItem;
            Destination currentDestination = ReturnDestination(targetArea);
            UseAutorun();
            do
            {
                
                MakeBitmap();
                FindMap(OverallScreenBitmap);
                MakeMap();
                var newMapCheck = FindCharacterOnMap();
                if (counter == 0)
                {
                    PreviousPosition = MapCharacter;
                    GenerateWallPixelTiles();
                }
                if(newMapCheck == null)
                {
                    MessageBox.Show("You have reached your destination");
                    Active = false;
                    goto end;
                }
                PathingAlgorithm(currentDestination);
                //LockandReadImage(OverallScreenBitmap); // also attacks for now
                counter++;
                 end:;

            } while (Active == true);
        }

        private void SellItem()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_W, IntPtr.Zero);
            System.Threading.Thread.Sleep(200);
            MakeBitmap();
            CheckIfBagIsFull();
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_W, IntPtr.Zero);
            System.Threading.Thread.Sleep(200);
            if (SellItems == true)
            {
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_2, IntPtr.Zero);
                System.Threading.Thread.Sleep(200);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_B, IntPtr.Zero);
                System.Threading.Thread.Sleep(500);

                int counter = 0;
                bool Active = false;
                do
                {
                    MakeBitmap();
                    FindMap(OverallScreenBitmap);
                    MakeMap();
                    var newMapCheck = FindCharacterOnMap();
                    PixelLocation currentLocation = new PixelLocation(82, 76);
                    Destination currentDestination = new Destination("Dest", currentLocation);
                    if (counter == 0)
                    {
                        PreviousPosition = MapCharacter;
                        GenerateWallPixelTiles();
                    }
                    PathingAlgorithmShop(currentDestination);

                } while (Active == true);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_B, IntPtr.Zero);
                System.Threading.Thread.Sleep(200);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_B, IntPtr.Zero);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(795, 318);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(80, 89);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(294, 526);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(457, 526);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(294, 526);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(457, 526); 
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(294, 526);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(457, 526);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(294, 526);
                System.Threading.Thread.Sleep(200);
                DoMouseClickShop(457, 526);
                System.Threading.Thread.Sleep(200);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_ESCAPE, IntPtr.Zero);
                System.Threading.Thread.Sleep(100);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_ESCAPE, IntPtr.Zero);
                System.Threading.Thread.Sleep(100);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_ESCAPE, IntPtr.Zero);
                System.Threading.Thread.Sleep(100);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_ESCAPE, IntPtr.Zero);
                System.Threading.Thread.Sleep(100);
                DoMouseClickShop(695, 152);
                System.Threading.Thread.Sleep(100);
                DoMouseClickShop(65, 130);
                System.Threading.Thread.Sleep(100);
                DoMouseClickShop(1319, 314);
                System.Threading.Thread.Sleep(100);
                DoMouseClickShop(135, 103);
                System.Threading.Thread.Sleep(100);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_B, IntPtr.Zero);
                System.Threading.Thread.Sleep(100);
                IsPlayedShop = true;
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_D, IntPtr.Zero);
                do
                {
                    MakeBitmap();
                    FindMap(OverallScreenBitmap);
                    MakeMap();
                    var newMapCheck = FindCharacterOnMap();
                    PixelLocation currentLocation = new PixelLocation(696, 77);
                    Destination currentDestination = new Destination("Dest", currentLocation);
                    if (counter == 0)
                    {
                        PreviousPosition = MapCharacter;
                        GenerateWallPixelTiles();
                    }
                    PathingAlgorithm(currentDestination);

                } while (IsPlayedShop == true);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_D, IntPtr.Zero);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_B, IntPtr.Zero);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_B, IntPtr.Zero);
                

            }
        }

        private void SearchCurrentAreaButton_Click(object sender, EventArgs e)
        {
            Area currentArea = DeserializeMap(AreaSearchTextBox.Text);
            foreach (var item in currentArea.Areas)
            {
                SearchCurrentAreaListBox.Items.Add(item.Name);
            }
         
        }

        //Put buffs on f6+ to ensure it works, put spammable spell on f1
        public void AttackChecker()
        {
            if (F1CheckBox.Checked)// && (F1StopWatch.IsRunning == false || F1StopWatch.ElapsedMilliseconds / 1000 > Convert.ToDouble(F1TimerTextBox.Text) ))
            {
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F1, IntPtr.Zero);
                F1StopWatch.Restart();

            }
            if (F2CheckBox.Checked && (F2StopWatch.IsRunning == false || F2StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F2TimerTextBox.Text)))
            {
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F2, IntPtr.Zero);
                F2StopWatch.Restart();

                System.Threading.Thread.Sleep(100);


            }
            if (F3CheckBox.Checked && (F3StopWatch.IsRunning == false || F3StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F3TimerTextBox.Text)))
            {
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F3, IntPtr.Zero);
                F3StopWatch.Restart();


                System.Threading.Thread.Sleep(100);

            }
            if (F4CheckBox.Checked && (F4StopWatch.IsRunning == false || F4StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F4TimerTextBox.Text)))
            {
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F4, IntPtr.Zero);
                F4StopWatch.Restart();

                System.Threading.Thread.Sleep(100);


            }
            if (F5CheckBox.Checked && (F5StopWatch.IsRunning == false || F5StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F5TimerTextBox.Text)))
            {
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F5, IntPtr.Zero);
                F5StopWatch.Restart();

                System.Threading.Thread.Sleep(100);

            }
            if (F6CheckBox.Checked && (F6StopWatch.IsRunning == false || F6StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F6TimerTextBox.Text)))
            {
                System.Threading.Thread.Sleep(1500);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F6, IntPtr.Zero);
                F6StopWatch.Restart();
    

            }
            if (F7CheckBox.Checked && (F7StopWatch.IsRunning == false || F7StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F7TimerTextBox.Text)))
            {
                System.Threading.Thread.Sleep(1500);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F7, IntPtr.Zero);
                F7StopWatch.Restart();


            }
            if (F8CheckBox.Checked && (F8StopWatch.IsRunning == false || F8StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F8TimerTextBox.Text)))
            {
                System.Threading.Thread.Sleep(1500);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F8, IntPtr.Zero);
                F8StopWatch.Restart();


            }
            if (F9CheckBox.Checked && (F9StopWatch.IsRunning == false || F9StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F9TimerTextBox.Text)))
            {
                System.Threading.Thread.Sleep(1500);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F9, IntPtr.Zero);
                F9StopWatch.Restart();


            }
            if (F10CheckBox.Checked && (F10StopWatch.IsRunning == false || F10StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F10TimerTextBox.Text)))
            {
                System.Threading.Thread.Sleep(1500);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F10, IntPtr.Zero);
                F10StopWatch.Restart();

            }
            if (F11CheckBox.Checked && (F11StopWatch.IsRunning == false || F11StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F11TimerTextBox.Text)))
            {
                System.Threading.Thread.Sleep(1500);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F11, IntPtr.Zero);
                F11StopWatch.Restart();

            }
            if (F12CheckBox.Checked && (F12StopWatch.IsRunning == false || F12StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(F12TimerTextBox.Text)))
            {
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F12, IntPtr.Zero);
                F12StopWatch.Restart();
                
                System.Threading.Thread.Sleep(1500);
            }
            if (N1CheckBox.Checked && (N1StopWatch.IsRunning == false || N1StopWatch.ElapsedMilliseconds / 1000 > Int32.Parse(N1TimerTextBox.Text)))
            {
                System.Threading.Thread.Sleep(1000);
                SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_1, IntPtr.Zero);
                N1StopWatch.Restart();


            }
        }

        public void UseAutorun()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_D, IntPtr.Zero);

        }
        public void UseRT()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_1, IntPtr.Zero);

        }
        public void CastBuffs()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F2, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F3, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F4, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F5, IntPtr.Zero);

        }
        private void PickUpItems()
        {
            DoMouseClickPickUp(Character.X, Character.Y);
            DoMouseClickPickUp(Character.X, Character.Y);
            DoMouseClickPickUp(Character.X, Character.Y);
            DoMouseClickPickUp(Character.X, Character.Y);
            DoMouseClickPickUp(Character.X, Character.Y);
            DoMouseClickPickUp(Character.X, Character.Y);
            DoMouseClickPickUp(Character.X, Character.Y);
        }

        public void DoMouseClickAttack(int X, int Y)
        {

            

            //Call the imported function with the cursor's current position
            //SetCursorPos(X, Y);
            //SetForegroundWindow(HWND);
            SendMessage(HWND, WM_MOUSEMOVE, (IntPtr)0, BuildLParam((uint)X,(uint)Y));

            if (AttackCheckBox.Checked == true)
            {
               // mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)X, (uint)Y, 0, 0);
                SendMessage(HWND, WM_LBUTTONDOWN, (IntPtr)0, BuildLParam((uint)X,(uint)Y));
                System.Threading.Thread.Sleep(200);
                SendMessage(HWND, WM_LBUTTONUP, (IntPtr)0, BuildLParam((uint)X, (uint)Y));

               // mouse_event(MOUSEEVENTF_LEFTUP, (uint)X, (uint)Y, 0, 0);
            }
 

        }
        public void DoMouseClickPickUp(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SendMessage(HWND, WM_MOUSEMOVE, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            SendMessage(HWND, WM_LBUTTONDOWN, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            System.Threading.Thread.Sleep(50);
            SendMessage(HWND, WM_LBUTTONUP, (IntPtr)0, BuildLParam((uint)X, (uint)Y));



        }

        public void DoMouseClickTravel(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SendMessage(HWND, WM_MOUSEMOVE, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            //SetForegroundWindow(HWND);
            //mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)X, (uint)Y, 0, 0);
            System.Threading.Thread.Sleep(400);
            //mouse_event(MOUSEEVENTF_LEFTUP, (uint)X, (uint)Y, 0, 0);


        }
        public void DoMouseClickTravelShop(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SendMessage(HWND, WM_MOUSEMOVE, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            //SetForegroundWindow(HWND);
            SendMessage(HWND, WM_LBUTTONDOWN, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            System.Threading.Thread.Sleep(200);
            SendMessage(HWND, WM_LBUTTONUP, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            System.Threading.Thread.Sleep(500);


        }
        public void DoMouseClickShop(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SendMessage(HWND, WM_MOUSEMOVE, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            //SetForegroundWindow(HWND);
            System.Threading.Thread.Sleep(200);
            SendMessage(HWND, WM_LBUTTONDOWN, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            System.Threading.Thread.Sleep(200);
            SendMessage(HWND, WM_LBUTTONUP, (IntPtr)0, BuildLParam((uint)X, (uint)Y));
            System.Threading.Thread.Sleep(200);


        }

        public unsafe List<PixelLocation> GenerateWallPixelTiles()
        {
            BitmapData bData = new BitmapData();

            bData = MapBitmap.LockBits(new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height), ImageLockMode.ReadWrite, MapBitmap.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            /*This time we convert the IntPtr to a ptr*/
            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            //Find Dungeons
            for (int i = 0; i < bData.Height; ++i)
            {
                for (int j = 0; j < bData.Width; ++j)
                {

                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    if (color[0] == 0 && color[1] == 0 && color[3] != 8)
                    {
                        TraversablePixelList.Add(new PixelLocation(j, i));
                    }



                }
            }
            MapBitmap.UnlockBits(bData);
            return TraversablePixelList;
        }
        public unsafe void FindDestinations()
        {
            BitmapData bData = new BitmapData();

            bData = MapBitmap.LockBits(new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height), ImageLockMode.ReadWrite, MapBitmap.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            /*This time we convert the IntPtr to a ptr*/
            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            //Find Dungeons
            for (int i = 0; i < bData.Height - 2; ++i)
            {
                for (int j = 0; j < bData.Width - 2; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 2) * bData.Stride + j * bitsPerPixel / 8;

                    if (color[0] == 0 && color[1] == 48 && color[2] == 176 && color1[0] == 0 && color1[1] == 48 && color1[2] == 176 && color2[0] == 0 && color2[1] == 0 && color2[2] == 8)
                    {
                        DungeonPixelList.Add(new PixelLocation(j, i));
                    }

                }
            }

            //Find OpenAreas
            for (int i = 0; i < bData.Height - 2; ++i)
            {
                for (int j = 0; j < bData.Width - 2; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 2) * bData.Stride + j * bitsPerPixel / 8;

                    if (color[0] == 140 && color[1] == 128 && color[2] == 119 && color1[0] == 255 && color1[1] == 251 && color1[2] == 239 && color2[0] == 255 && color2[1] == 227 && color2[2] == 206)
                    {
                        OpenAreaPixelList.Add(new PixelLocation(j, i));
                    }

                }
            }
            MapBitmap.UnlockBits(bData);

        }

        public unsafe void CheckIfBagIsFull()
        {
            SellItems = false;
            BitmapData bData = new BitmapData();

            bData = OverallScreenBitmap.LockBits(new Rectangle(0, 0, OverallScreenBitmap.Width, OverallScreenBitmap.Height), ImageLockMode.ReadWrite, OverallScreenBitmap.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            /*This time we convert the IntPtr to a ptr*/
            byte* scan0 = (byte*)bData.Scan0.ToPointer();


            // Look for 3 black pixels in a colum next to a white
            byte* color = scan0 + 497 * bData.Stride + 1558 * bitsPerPixel / 8;
            if (color[0] != 12 && color[1] != 12 && color[2] != 24)
            {
                SellItems = true;
            }


            OverallScreenBitmap.UnlockBits(bData);

        }

        public Area DeserializeMap(string areaName)
        {
            //move to relative path for other computers
            string prajnaVilage = System.IO.File.ReadAllText($"C:\\Users\\con16\\Desktop\\Bitmat bot\\bitmap\\AreaJsons\\{areaName}.Json");
            CurrentArea = JsonConvert.DeserializeObject<Area>(prajnaVilage);
            return CurrentArea;
        }

        public Destination ReturnDestination(string listBoxSelect)
        {
            var currentDestination = new Destination(null, null);

            foreach (var item in CurrentArea.Areas)
            {
                if (item.Name == listBoxSelect)
                {
                    currentDestination = item;
                }
            }
            return currentDestination;
        }
        public void MakeBitmap()
        {
            //Create a new bitmap.
            OverallScreenBitmap = new Bitmap(1600, 900);

            // Create a graphics object from the bitmap.
            var gfxScreenshot = Graphics.FromImage(OverallScreenBitmap);

            // Take the screenshot from the upper left corner to the right bottom corner.
            gfxScreenshot.CopyFromScreen(rt.Left + 8,
                                        rt.Top + 31,
                                        0,
                                        0,
                                        new Rectangle(0, 0, 1600, 900).Size,
                                        CopyPixelOperation.SourceCopy);


        }

        public unsafe void FindMap(Bitmap bmpScreenshot)
        {
            MonsterPixelList.Clear();
            BitmapData bData = new BitmapData();

            bData = bmpScreenshot.LockBits(new Rectangle(0, 0, bmpScreenshot.Width, bmpScreenshot.Height), ImageLockMode.ReadWrite, bmpScreenshot.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            //Find top left
            for (int i = 0; i < bData.Height / 4 + 300; ++i)
            {
                for (int j = 0; j < bData.Width / 4 + 300; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color3 = scan0 + (i + 1) * bData.Stride + (j + 1) * bitsPerPixel / 8;

                    if (color[0] == 99 && color[1] == 166 && color[2] == 198 && color1[0] == 99 && color1[1] == 166 && color1[2] == 198 && color2[0] == 99 && color2[1] == 166 && color2[2] == 198 && color3[0] == 0 && color3[1] == 0 && color3[2] == 0)
                    {
                        MapTopLeftPixel = new PixelLocation(j, i);
                        goto end;
                    }


                }
            }
            end:
            //Find bottom right
            for (int i = bData.Height / 2; i < bData.Height - 1; ++i)
            {
                for (int j = bData.Width / 2; j < bData.Width - 1; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color3 = scan0 + (i + 1) * bData.Stride + (j + 1) * bitsPerPixel / 8;

                    if (color[0] == 0 && color[1] == 0 && color[2] == 0 && color1[0] == 99 && color1[1] == 166 && color1[2] == 198 && color2[0] == 99 && color2[1] == 166 && color2[2] == 198 && color3[0] == 99 && color3[1] == 166 && color3[2] == 198)
                    {
                        MapBottomRightPixel = new PixelLocation(j, i);
                        goto end1;
                    }

                }
            }
            end1:

            bmpScreenshot.UnlockBits(bData);


        }

        public Bitmap MakeMap()
        {
            MapBitmap = new Bitmap(MapBottomRightPixel.X - MapTopLeftPixel.X, MapBottomRightPixel.Y - MapTopLeftPixel.Y);
            using (Graphics graphics = Graphics.FromImage(MapBitmap))
            {
                Rectangle mapRectangle = new Rectangle(MapTopLeftPixel.X, MapTopLeftPixel.Y, MapBitmap.Width, MapBitmap.Height);
                Rectangle sizeRectangle = new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height);

                graphics.DrawImage(OverallScreenBitmap, 0, 0, mapRectangle, GraphicsUnit.Pixel);
            }
            return MapBitmap;

        }

        public unsafe PixelLocation FindCharacterOnMap()
        {

            MapCharacter = new PixelLocation(-1000, -1000);
            BitmapData bData = new BitmapData();

            bData = MapBitmap.LockBits(new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height), ImageLockMode.ReadWrite, MapBitmap.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            byte* scan0 = (byte*)bData.Scan0.ToPointer();
            for (int i = 0; i < bData.Height - 1; ++i)
            {
                for (int j = 0; j < bData.Width - 1; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;


                    if (color[0] == 255 && color[1] == 255 && color[2] == 0)
                    {
                        MapCharacter = new PixelLocation(j, i);
                        goto end;
                    }

                    //color is a pointer to the first byte of the 3-byte color data
                    //color[0] = blueComponent;
                    //color[1] = greenComponent;
                    //color[2] = redComponent;

                }
            }
        end:;
            MapBitmap.UnlockBits(bData);
            return MapCharacter;


        }




        public unsafe void LockandReadImage(Bitmap bmpScreenshot)
        {
            MonsterPixelList.Clear();
            BitmapData bData = new BitmapData();

            bData = bmpScreenshot.LockBits(new Rectangle(0, 0, bmpScreenshot.Width, bmpScreenshot.Height), ImageLockMode.ReadWrite, bmpScreenshot.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            for (int i = 0; i < bData.Height - 100; ++i)
            {
                for (int j = 0; j < bData.Width - 1; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color3 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;

                    if (color[0] == color[1] && color[0] == color[2] && color[0] == 0 && color1[0] == color1[1] && color1[0] == color1[2] && color1[0] == 0 && color2[0] == color2[1] && color2[0] == color2[2] && color2[0] == 0 && color3[0] == color3[1] && color3[0] == color3[2] && color3[0] > 100)
                    {
                        MonsterPixelList.Add(new PixelLocation(j, i));
                    }


                }
            }

            bmpScreenshot.UnlockBits(bData);
            Character = new PixelLocation(bmpScreenshot.Width / 2, bmpScreenshot.Height / 2);
            MinDistance = 100000000;
            foreach (var pixel in MonsterPixelList)
            {
                double dist = Math.Sqrt(Math.Pow(Character.X - pixel.X, 2) + Math.Pow(Character.Y - pixel.Y, 2));
                if (dist < MinDistance && dist > 50)
                {
                    MinDistance = dist;
                    MinCoord = pixel;
                }
            }

            //DoMouseClickAttack(MinCoord.X + MyRect.X + 8, MinCoord.Y + MyRect.Y + 31);
            DoMouseClickAttack(MinCoord.X, MinCoord.Y);



        }
        public class Tile
        {
            public int X { get; set; }
            public int Y { get; set; }
            public int Cost { get; set; }
            public int Distance { get; set; }
            public int CostDistance => Cost + Distance;
            public Tile Parent { get; set; }

            //The distance is essentially the estimated distance, ignoring walls to our target. 
            //So how many tiles left and right, up and down, ignoring walls, to get there. 
            public void SetDistance(int targetX, int targetY)
            {
                this.Distance = Math.Abs(targetX - X) + Math.Abs(targetY - Y);
            }
        }
        public void PathingAlgorithm(Destination currentDestination)
        {
            Tile characterTile = new Tile();
            characterTile.X = MapCharacter.X;
            characterTile.Y = MapCharacter.Y;
            Tile currentDestinationTile = new Tile();
            currentDestinationTile.X = currentDestination.Location.X;
            currentDestinationTile.Y = currentDestination.Location.Y;


            SetStartOfPath(MapCharacter, currentDestination.Location);
            DoAlg(currentDestinationTile, MapBitmap, currentDestination);

        }



        public void DoAlg(Tile finish, Bitmap map, Destination currentDestination)
        {
            //This is where we created the map from our previous step etc. 
            int counter = 0;
            while (ActiveTiles.Any())
            {
                if (ActiveTiles.Count == 0)
                {
                    VisitedTiles.Clear();
                }
                var checkTile = ActiveTiles.OrderBy(x => x.CostDistance).First();
                Tile currentPositionTile = new Tile();
                currentPositionTile = checkTile;
                MakeBitmap();
                FindMap(OverallScreenBitmap);
                MakeMap();
                var newMapCheck = FindCharacterOnMap();
                if (newMapCheck.X == -1000 && newMapCheck.Y == -1000)
                {
                    IsPlayedShop = false;
                    return;
                }
                ActiveTiles.Remove(checkTile);
                Movement(checkTile);
                bool successfulMovement = CheckMovementSuccessful(PreviousPosition);
                if (successfulMovement == true)
                {  
                    PreviousTile = checkTile;  
                                        
                }
                VisitedTiles.Add(currentPositionTile);
                if (true)
                {
                    VisitedTilesScan(checkTile);
                }
                PreviousPosition = MapCharacter;
                if (counter == 0)
                {
                    PreviousTile = checkTile;
                    UpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);
                }
                //Try to move and if we fail, update the wall tiles
                if (successfulMovement == false)
                {
                    WallTileList.Add(checkTile);
                }
                else
                {
                    UpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);

                }
                counter++;

            }

            Console.WriteLine("No Path Found!");
        }

        public void VisitedTilesScan(Tile checkTile)
        {
            int x = PreviousPosition.X;
            int y = PreviousPosition.Y;
            Func<int, int> step = PreviousPosition.X < checkTile.X ? (i) => { return ++i; } : (i) => { return --i; };
            Func<int, int> step2 = PreviousPosition.Y < checkTile.Y ? (i2) => { return ++i2; } : (i2) => { return --i2; };



            if (x != checkTile.X && y == checkTile.Y)
            {
                while (x != checkTile.X)
                {
                    VisitedTiles.Add(new Tile { X = x, Y = PreviousPosition.Y, Parent = null, Cost = PreviousTile.Cost });
                    x = step(x);
                }

            }
            else if (x == checkTile.X && y != checkTile.Y)
            {
                while (y != checkTile.Y)
                {
                    VisitedTiles.Add(new Tile { X = PreviousPosition.X, Y = y, Parent = null, Cost = PreviousTile.Cost });
                    y = step2(y);
                }
            }
            else if (x != checkTile.X && y != checkTile.Y)
            {
                for (x = PreviousPosition.X; x != checkTile.X; x = step(x))
                {

                    for (y = PreviousPosition.Y; y != checkTile.Y; y = step2(y))
                    {
                        VisitedTiles.Add(new Tile { X = x, Y = y, Parent = null, Cost = PreviousTile.Cost });

                    }
                }
            }
            else
            {

            }
        }
        public void UpdateActiveAndVisitedTiles(Tile checkTile, Bitmap map, Tile finish, Destination currentDestination, bool successfulMovement)
        {
            ActiveTiles.Clear();
            
            checkTile.X = MapCharacter.X;
            checkTile.Y = MapCharacter.Y;

            var walkableTiles = GetWalkableTiles(map, checkTile, finish, WallTileList, currentDestination.Location);

            foreach (var walkableTile in walkableTiles)
            {
                //We have already visited this tile so we don't need to do so again!
                if (VisitedTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                    continue;

                //It's already in the active list, but that's OK, maybe this new tile has a better value (e.g. We might zigzag earlier but this is now straighter). 
                if (ActiveTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                {
                    var existingTile = ActiveTiles.First(x => x.X == walkableTile.X && x.Y == walkableTile.Y);
                    if (existingTile.CostDistance > checkTile.CostDistance)
                    {
                        ActiveTiles.Remove(existingTile);
                        ActiveTiles.Add(walkableTile);

                    }
                }
                else
                {
                    //We've never seen this tile before so add it to the list. 
                    ActiveTiles.Add(walkableTile);
                }
            }
        }

        public bool CheckMovementSuccessful(PixelLocation currentPosition)
        {
            MakeBitmap();
            FindMap(OverallScreenBitmap);
            MakeMap();
            MapCharacter = FindCharacterOnMap();
            if (MapCharacter.X != PreviousPosition.X || MapCharacter.Y != PreviousPosition.Y || (MapCharacter.X == -1000 && MapCharacter.Y == -1000))
            {
                return true;
            }
            else
            {
                return false;
            }

        }
        public void Movement(Tile checkTile)
        {
            if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South East
                DoMouseClickTravel(1348, 700);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South West
                DoMouseClickTravel(256, 619);

            }
            else if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North East
                DoMouseClickTravel(1290, 139);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North West
                DoMouseClickTravel(324, 121);

            }
            else if (checkTile.X - MapCharacter.X == 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North

                DoMouseClickTravel(812, 73);

            }
            else if (checkTile.X - MapCharacter.X == 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South
                DoMouseClickTravel(809, 789);

            }
            else if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y == 0)
            {
                //East
                DoMouseClickTravel(1341, 426);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y == 0)
            {
                //West
                DoMouseClickTravel(232, 444);

            }
            else
            {
                // if dont move do nothing
            }
        }

        public void SetStartOfPath(PixelLocation Character, PixelLocation Destination)
        {

            var start = new Tile();
            start.Y = Character.Y;
            start.X = Character.X;

            var finish = new Tile();
            finish.Y = Destination.Y;
            finish.X = Destination.X;

            start.SetDistance(finish.X, finish.Y);
            ActiveTiles.Add(start);
        }
        public List<Tile> GetWalkableTiles(Bitmap map, Tile currentTile, Tile targetTile, List<Tile> WallTileList, PixelLocation Destination)
        {
           
            var possibleTiles = new List<Tile>()
            {
            
            new Tile { X = currentTile.X + 3, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 3, Y = currentTile.Y + 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y + 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 3, Y = currentTile.Y - 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y- 2, Parent = currentTile, Cost = currentTile.Cost + 1},
            new Tile { X = currentTile.X - 3, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 3, Y = currentTile.Y + 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 3, Y = currentTile.Y - 2, Parent = currentTile, Cost = currentTile.Cost + 1 },

            };

            possibleTiles.ForEach(tile => tile.SetDistance(targetTile.X, targetTile.Y));

            var maxX = map.Width;
            var maxY = map.Height;
            List<int> intList = new List<int>();
            intList.Clear();

            return possibleTiles
            .Where(tile => !WallTileList.Any(x => x.X == tile.X && x.Y == tile.Y ))
            .ToList();
        }

        ///////////////////////////////////////////////////////////////////////////
        ///FIRST PASS///////////
        ///////////////////////////////////////////////////////////////////////////

        public void FPPathingAlgorithm(Destination currentDestination)
        {
            Tile characterTile = new Tile();
            characterTile.X = MapCharacter.X;
            characterTile.Y = MapCharacter.Y;
            Tile currentDestinationTile = new Tile();
            currentDestinationTile.X = currentDestination.Location.X;
            currentDestinationTile.Y = currentDestination.Location.Y;
            var map = GenerateWallPixelTiles();

            FPSetStartOfPath(MapCharacter, currentDestination.Location);
            FPDoAlg(currentDestinationTile, map, currentDestination);

        }
        public void FPSetStartOfPath(PixelLocation Character, PixelLocation Destination)
        {

            var start = new Tile();
            start.Y = Character.Y;
            start.X = Character.X;

            var finish = new Tile();
            finish.Y = Destination.Y;
            finish.X = Destination.X;

            start.SetDistance(finish.X, finish.Y);
            ActiveTiles.Add(start);
        }
        public void FPDoAlg(Tile finish, List<PixelLocation> map, Destination currentDestination)
        {
            //This is where we created the map from our previous step etc. 
            while (ActiveTiles.Any())
            {
                var checkTile = ActiveTiles.OrderBy(x => x.CostDistance).First();

                if (checkTile.X == finish.X && checkTile.Y == finish.Y)
                {
                    List<Tile> OptimalPath = new List<Tile>();
                    var tile = checkTile;
                    while (true)
                    {
                        
                        OptimalPath.Add(tile);
                        tile = tile.Parent;

                        if (tile == null)
                        {
                            
                            return;
                        }
                    }
                    
                }
                bool successfulMovement = true;
                VisitedTiles.Add(checkTile);
                ActiveTiles.Remove(checkTile);
                FPUpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);

            }

            Console.WriteLine("No Path Found!");
        }
        public void FPUpdateActiveAndVisitedTiles(Tile checkTile, List<PixelLocation> map, Tile finish, Destination currentDestination, bool successfulMovement)
        {

            var walkableTiles = FPGetWalkableTiles(map, checkTile, finish, WallTileList, currentDestination.Location);

            foreach (var walkableTile in walkableTiles)
            {
                //We have already visited this tile so we don't need to do so again!
                if (VisitedTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                    continue;

                //It's already in the active list, but that's OK, maybe this new tile has a better value (e.g. We might zigzag earlier but this is now straighter). 
                if (ActiveTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                {
                    var existingTile = ActiveTiles.First(x => x.X == walkableTile.X && x.Y == walkableTile.Y);
                    if (existingTile.CostDistance > checkTile.CostDistance)
                    {
                        ActiveTiles.Remove(existingTile);
                        ActiveTiles.Add(walkableTile);

                    }
                }
                else
                {
                    //We've never seen this tile before so add it to the list. 
                    ActiveTiles.Add(walkableTile);
                }
            }
        }
        public List<Tile> FPGetWalkableTiles(List<PixelLocation> map, Tile currentTile, Tile targetTile, List<Tile> WallTileList, PixelLocation Destination)
        {
            var possibleTiles = new List<Tile>()
            {
            new Tile { X = currentTile.X + 1, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 1, Y = currentTile.Y + 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y + 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 1, Y = currentTile.Y - 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y- 1, Parent = currentTile, Cost = currentTile.Cost + 1},
            new Tile { X = currentTile.X - 1, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 1, Y = currentTile.Y + 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 1, Y = currentTile.Y - 1, Parent = currentTile, Cost = currentTile.Cost + 1 },

            };

            possibleTiles.ForEach(tile => tile.SetDistance(targetTile.X, targetTile.Y));

            var maxX = MapBitmap.Width;
            var maxY = MapBitmap.Height;

            return possibleTiles
            .Where(tile => tile.X >= 0 && tile.X <= maxX)
            .Where(tile => tile.Y >= 0 && tile.Y <= maxY)
            .Where(tile => !WallTileList.Contains(tile))
            .ToList();
        }

        ///////////////////////////////////////////
        ////SHOP///////////////////////////////////
        //////////////////////////////////////////
        public void PathingAlgorithmShop(Destination currentDestination)
        {
            Tile characterTile = new Tile();
            characterTile.X = MapCharacter.X;
            characterTile.Y = MapCharacter.Y;
            Tile currentDestinationTile = new Tile();
            currentDestinationTile.X = currentDestination.Location.X;
            currentDestinationTile.Y = currentDestination.Location.Y;


            SetStartOfPath(MapCharacter, currentDestination.Location);
            DoAlgShop(currentDestinationTile, MapBitmap, currentDestination);

         }
        public void DoAlgShop(Tile finish, Bitmap map, Destination currentDestination)
        {
            //This is where we created the map from our previous step etc. 
            int counter = 0;
            while (ActiveTiles.Any())
            {
                var checkTile = ActiveTiles.OrderBy(x => x.CostDistance).First();
                Tile currentPositionTile = new Tile();
                currentPositionTile = checkTile;
                MakeBitmap();
                FindMap(OverallScreenBitmap);
                MakeMap();
                var newMapCheck = FindCharacterOnMap();
                if (newMapCheck.X == finish.X && newMapCheck.Y == finish.Y)
                {

                    return;
                }
                ActiveTiles.Remove(checkTile);
                MovementShop(checkTile);
                bool successfulMovement = CheckMovementSuccessful(PreviousPosition);
                if (successfulMovement == true)
                {
                    PreviousTile = checkTile;

                }
                VisitedTiles.Add(currentPositionTile);
                if (true)
                {
                    VisitedTilesScan(checkTile);
                }
                PreviousPosition = MapCharacter;
                if (counter == 0)
                {
                    PreviousTile = checkTile;
                    UpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);
                }
                //Try to move and if we fail, update the wall tiles
                if (successfulMovement == false)
                {
                    WallTileList.Add(checkTile);
                }
                else
                {
                    UpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);

                }
                if(counter > 30)
                {
                    counter = 0;
                    SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_2, IntPtr.Zero);
                    System.Threading.Thread.Sleep(200);
                }
                counter++;

            }

            Console.WriteLine("No Path Found!");
        }
        public void MovementShop(Tile checkTile)
        {
            if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South East
                DoMouseClickTravelShop(1348 + MyRect.X + 8, 700 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South West
                DoMouseClickTravelShop(256 + MyRect.X + 8, 619 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North East
                DoMouseClickTravelShop(1290 + MyRect.X + 8, 139 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North West
                DoMouseClickTravelShop(324 + MyRect.X + 8, 121 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X == 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North

                DoMouseClickTravelShop(812 + MyRect.X + 8, 73 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X == 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South
                DoMouseClickTravelShop(809 + MyRect.X + 8, 789 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y == 0)
            {
                //East
                DoMouseClickTravelShop(1341 + MyRect.X + 8, 426 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y == 0)
            {
                //West
                DoMouseClickTravelShop(232 + MyRect.X + 8, 444 + MyRect.Y + 31);

            }
            else
            {
                // if dont move do nothing
            }
        }

    }









public class PixelLocation
    {
        public PixelLocation(int x, int y)
        {
            X = x;
            Y = y;
        }

        public int X { get; set; }
        public int Y { get; set; }
    }

    public class Pixelcolor
    {
        public Pixelcolor(byte b, byte g, byte r)
        {
            B = b;
            G = g;
            R = r;
        }

        public byte B { get; set; }
        public byte G { get; set; }
        public byte R { get; set; }
    }


}
